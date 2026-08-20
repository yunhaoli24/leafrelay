import {posix} from 'node:path';
import type {ProjectFileTreeDiffResponseSchema} from '../api/base';
import type {RemoteEntry} from './remoteProject';
import {
    createSyncState,
    type LocalReplicaSyncState,
    readTextBase,
    removeSyncCheckpoint,
    sha256,
    updateSyncCheckpoint,
} from './checkpoint';
import {mergeText} from './threeWayMerge';

export interface ReplicaFileSystem {
    listFiles(): Promise<string[]>;
    read(path:string): Promise<Uint8Array | undefined>;
    write(path:string, content:Uint8Array): Promise<void>;
    remove(path:string): Promise<void>;
    watch(onChange:(path:string) => void): Promise<() => Promise<void>>;
}

export interface RemoteReplica {
    listEntries(): RemoteEntry[];
    entry(path:string): RemoteEntry | undefined;
    read(path:string): Promise<Uint8Array>;
    write(path:string, content:Uint8Array): Promise<void>;
    remove(path:string): Promise<void>;
    getCurrentVersion(): Promise<number>;
    getFileTreeDiff(from:number, to:number): Promise<ProjectFileTreeDiffResponseSchema | undefined>;
    onChange(handler:(change:{path:string; previousPath?:string}) => void): void;
}

export interface SyncStateStore {
    load(): Promise<LocalReplicaSyncState | undefined>;
    save(state:LocalReplicaSyncState): Promise<void>;
}

export interface SyncEngineOptions {
    projectUri:string;
    local:ReplicaFileSystem;
    remote:RemoteReplica;
    stateStore:SyncStateStore;
    ignore(path:string):boolean;
    log(message:string):void;
    onConflict(path:string, reason:string):void;
}

type ChangeSource = 'local' | 'remote';

function normalizePath(path:string):string {
    return `/${posix.normalize(path).replace(/^\/+/, '')}`;
}

function isRemoteFile(entry:RemoteEntry|undefined):boolean {
    return entry?.type==='doc' || entry?.type==='file';
}

export class SyncEngine {
    private state?: LocalReplicaSyncState;
    private queue:Promise<void> = Promise.resolve();
    private conflicts = new Set<string>();
    private stopLocalWatch?: () => Promise<void>;
    private eventTimers = new Map<string, NodeJS.Timeout>();

    constructor(private readonly options:SyncEngineOptions) {}

    async start():Promise<void> {
        this.state = await this.options.stateStore.load();
        const currentVersion = await this.options.remote.getCurrentVersion();
        const localFiles = await this.options.local.listFiles();
        const remoteFiles = this.remoteFilePaths();

        if (!this.state) {
            this.state = createSyncState(this.options.projectUri, currentVersion);
            if (localFiles.length!==0 && remoteFiles.length!==0) {
                throw new Error('Synchronization paused: both the local and Overleaf projects contain files, but no common checkpoint exists.');
            }
            const source:ChangeSource = localFiles.length===0 ? 'remote' : 'local';
            for (const path of source==='remote' ? remoteFiles : localFiles) {
                await this.reconcilePath(path, source);
            }
            this.state.remoteVersion = currentVersion;
            await this.options.stateStore.save(this.state);
        } else {
            await this.startupReconcile(currentVersion, localFiles, remoteFiles);
        }

        this.stopLocalWatch = await this.options.local.watch(path => this.schedule(path, 'local'));
        this.options.remote.onChange(change => {
            if (change.previousPath) { this.schedule(change.previousPath, 'remote'); }
            this.schedule(change.path, 'remote');
        });
        this.options.log(`Synchronization active at Overleaf version ${this.state.remoteVersion}.`);
    }

    async stop():Promise<void> {
        for (const timer of this.eventTimers.values()) { clearTimeout(timer); }
        this.eventTimers.clear();
        await this.stopLocalWatch?.();
        await this.queue;
    }

    getConflicts():string[] {
        return [...this.conflicts].sort();
    }

    async resolveConflict(path:string, winner:'local'|'remote'):Promise<void> {
        const normalized = normalizePath(path);
        if (!this.conflicts.has(normalized)) {
            throw new Error(`No unresolved conflict exists for ${normalized}.`);
        }
        await this.enqueue(async () => {
            const remoteEntry = this.options.remote.entry(normalized);
            if (winner==='local') {
                const localContent = await this.options.local.read(normalized);
                if (localContent) {
                    await this.options.remote.write(normalized, localContent);
                    const synchronized = await this.options.remote.read(normalized);
                    if (sha256(synchronized)!==sha256(localContent)) {
                        await this.options.local.write(normalized, synchronized);
                    }
                    updateSyncCheckpoint(this.state!, normalized, synchronized);
                } else {
                    if (remoteEntry) { await this.options.remote.remove(normalized); }
                    removeSyncCheckpoint(this.state!, normalized);
                }
            } else if (isRemoteFile(remoteEntry)) {
                const remoteContent = await this.options.remote.read(normalized);
                await this.options.local.write(normalized, remoteContent);
                updateSyncCheckpoint(this.state!, normalized, remoteContent);
            } else {
                await this.options.local.remove(normalized);
                removeSyncCheckpoint(this.state!, normalized);
            }
            await this.options.stateStore.save(this.state!);
            this.conflicts.delete(normalized);
            this.options.log(`Resolved ${normalized} using ${winner==='local' ? 'local' : 'Overleaf'} content.`);
        });
    }

    async retry(path:string):Promise<void> {
        const normalized = normalizePath(path);
        this.conflicts.delete(normalized);
        await this.enqueue(() => this.reconcilePath(normalized, 'local'));
    }

    private async startupReconcile(currentVersion:number, localFiles:string[], remoteFiles:string[]) {
        const state = this.state!;
        if (state.remoteVersion>currentVersion) {
            throw new Error('Synchronization paused: the local checkpoint is newer than the Overleaf project history.');
        }
        const localHashes = new Map<string,string>();
        for (const path of localFiles) {
            const content = await this.options.local.read(path);
            if (content) { localHashes.set(path, sha256(content)); }
        }
        const localChanged = new Set<string>();
        for (const path of new Set([...Object.keys(state.files), ...localFiles])) {
            if (state.files[path]!==localHashes.get(path)) { localChanged.add(path); }
        }

        let remoteDiff:ProjectFileTreeDiffResponseSchema|undefined = {diff:[]};
        if (state.remoteVersion<currentVersion) {
            remoteDiff = await this.options.remote.getFileTreeDiff(state.remoteVersion, currentVersion);
            if (!remoteDiff) {
                throw new Error('Synchronization paused: Overleaf history is unavailable, so remote changes cannot be distinguished safely.');
            }
        }
        const candidates = new Set<string>(localChanged);
        const knownFiles = new Set([...Object.keys(state.files), ...localFiles, ...remoteFiles]);
        for (const change of remoteDiff.diff) {
            const paths = [change.pathname, change.newPathname].filter((path):path is string => Boolean(path));
            for (const changedPath of paths.map(normalizePath)) {
                let matched = false;
                for (const filePath of knownFiles) {
                    if (filePath===changedPath || filePath.startsWith(`${changedPath}/`)) {
                        candidates.add(filePath);
                        matched = true;
                    }
                }
                if (!matched) { candidates.add(changedPath); }
            }
        }

        let failed = false;
        for (const path of [...candidates].sort()) {
            try {
                await this.reconcilePath(path, localChanged.has(path) ? 'local' : 'remote');
            } catch (error) {
                failed = true;
                this.options.log(`Failed to synchronize ${path}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        if (failed) {
            throw new Error('Synchronization paused for failed paths; successful paths were checkpointed.');
        }
        state.remoteVersion = currentVersion;
        await this.options.stateStore.save(state);
        if (this.conflicts.size!==0) {
            this.options.log(`Synchronization remains active; ${this.conflicts.size} conflicting path(s) are paused.`);
        }
    }

    private schedule(path:string, source:ChangeSource) {
        const normalized = normalizePath(path);
        if (this.shouldIgnore(normalized) || this.conflicts.has(normalized)) { return; }
        const previous = this.eventTimers.get(normalized);
        if (previous) { clearTimeout(previous); }
        this.eventTimers.set(normalized, setTimeout(() => {
            this.eventTimers.delete(normalized);
            this.queue = this.queue.then(() => this.reconcilePath(normalized, source)).catch(error => {
                this.options.log(`Failed to synchronize ${normalized}: ${error instanceof Error ? error.message : String(error)}`);
            });
        }, 250));
    }

    private enqueue<T>(operation:() => Promise<T>):Promise<T> {
        const result = this.queue.then(operation);
        this.queue = result.then(() => undefined, () => undefined);
        return result;
    }

    private async reconcilePath(path:string, source:ChangeSource):Promise<void> {
        const normalized = normalizePath(path);
        if (this.shouldIgnore(normalized) || this.conflicts.has(normalized)) { return; }
        const remoteEntry = this.options.remote.entry(normalized);
        if (remoteEntry?.type==='folder') { return; }
        const localContent = await this.options.local.read(normalized);
        const remoteContent = isRemoteFile(remoteEntry) ? await this.options.remote.read(normalized) : undefined;
        const baseHash = this.state!.files[normalized];
        const localHash = localContent && sha256(localContent);
        const remoteHash = remoteContent && sha256(remoteContent);

        if (localHash===remoteHash) {
            if (localContent) { updateSyncCheckpoint(this.state!, normalized, localContent); }
            else { removeSyncCheckpoint(this.state!, normalized); }
            await this.options.stateStore.save(this.state!);
            return;
        }

        const localChanged = localHash!==baseHash;
        const remoteChanged = remoteHash!==baseHash;
        if (localChanged && remoteChanged) {
            const base = readTextBase(this.state, normalized);
            if (base && localContent && remoteContent) {
                const merged = mergeText(base, localContent, remoteContent);
                if (merged.status==='merged' && merged.content) {
                    await this.options.local.write(normalized, merged.content);
                    await this.options.remote.write(normalized, merged.content);
                    updateSyncCheckpoint(this.state!, normalized, merged.content);
                    await this.options.stateStore.save(this.state!);
                    this.options.log(`Merged non-overlapping local and Overleaf changes in ${normalized}.`);
                    return;
                }
            }
            this.conflicts.add(normalized);
            const reason = 'Both local and Overleaf content changed since the last synchronized checkpoint.';
            this.options.onConflict(normalized, reason);
            return;
        }

        if (localChanged || (!remoteChanged && source==='local')) {
            if (!localContent) {
                if (remoteEntry) { await this.options.remote.remove(normalized); }
                removeSyncCheckpoint(this.state!, normalized);
            } else {
                await this.options.remote.write(normalized, localContent);
                const synchronized = await this.options.remote.read(normalized);
                if (sha256(synchronized)!==sha256(localContent)) {
                    await this.options.local.write(normalized, synchronized);
                }
                updateSyncCheckpoint(this.state!, normalized, synchronized);
            }
            await this.options.stateStore.save(this.state!);
            return;
        }

        if (!remoteContent) {
            if (localContent) { await this.options.local.remove(normalized); }
            removeSyncCheckpoint(this.state!, normalized);
        } else {
            await this.options.local.write(normalized, remoteContent);
            updateSyncCheckpoint(this.state!, normalized, remoteContent);
        }
        await this.options.stateStore.save(this.state!);
    }

    private remoteFilePaths():string[] {
        return this.options.remote.listEntries()
            .filter(entry => isRemoteFile(entry) && !this.shouldIgnore(entry.path))
            .map(entry => entry.path);
    }

    private shouldIgnore(path:string):boolean {
        return this.options.ignore(path) || path.split('/').some(part => part.startsWith('.'));
    }
}
