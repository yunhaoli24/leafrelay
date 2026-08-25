import {posix} from 'node:path';
import type {ProjectFileTreeDiffResponseSchema} from '../api/base';
import type {RemoteEntry} from './remoteProject';
import {describeContentChange} from './changeSummary';
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
    onChange(handler:(change:{path:string; previousPath?:string; actor?:string}) => void): () => void;
    onReconnect?(handler:() => void): () => void;
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

interface PendingChange {
    timer:NodeJS.Timeout;
    source:ChangeSource;
    actors:Set<string>;
    unknownRemoteActor:boolean;
}

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
    private stopRemoteChange?:() => void;
    private stopRemoteReconnect?:() => void;
    private eventTimers = new Map<string, PendingChange>();
    private stopped = false;

    constructor(private readonly options:SyncEngineOptions) {}

    async start():Promise<void> {
        this.stopped = false;
        this.state = await this.options.stateStore.load();
        const currentVersion = await this.options.remote.getCurrentVersion();
        const localFiles = await this.options.local.listFiles();
        const remoteFiles = this.remoteFilePaths();

        if (!this.state || !this.state.initialized) {
            await this.initializeState(currentVersion, localFiles, remoteFiles);
        } else {
            this.restoreConflicts();
            await this.startupReconcile(currentVersion, localFiles, remoteFiles);
        }

        this.stopLocalWatch = await this.options.local.watch(path => this.schedule(path, 'local'));
        this.stopRemoteChange = this.options.remote.onChange(change => {
            if (this.stopped) { return; }
            if (change.previousPath) { this.schedule(change.previousPath, 'remote', change.actor); }
            this.schedule(change.path, 'remote', change.actor);
        });
        this.stopRemoteReconnect = this.options.remote.onReconnect?.(() => {
            if (this.stopped) { return; }
            this.queue = this.queue.then(() => this.reconcileAfterReconnect()).catch(error => {
                this.options.log(`Failed to reconcile after reconnecting: ${error instanceof Error ? error.message : String(error)}`);
            });
        });
        this.options.log(`Synchronization active at Overleaf version ${this.state!.remoteVersion}.`);
    }

    async stop():Promise<void> {
        this.stopped = true;
        this.stopRemoteChange?.();
        this.stopRemoteChange = undefined;
        this.stopRemoteReconnect?.();
        this.stopRemoteReconnect = undefined;
        for (const pending of this.eventTimers.values()) { clearTimeout(pending.timer); }
        this.eventTimers.clear();
        await this.stopLocalWatch?.();
        this.stopLocalWatch = undefined;
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
            this.conflicts.delete(normalized);
            delete this.state!.conflicts[normalized];
            await this.options.stateStore.save(this.state!);
            this.options.log(`Resolved ${normalized} using ${winner==='local' ? 'local' : 'Overleaf'} content.`);
        });
    }

    async retry(path:string):Promise<void> {
        const normalized = normalizePath(path);
        const reason = this.state!.conflicts[normalized];
        this.conflicts.delete(normalized);
        delete this.state!.conflicts[normalized];
        try {
            await this.enqueue(() => this.reconcilePath(normalized, 'local'));
        } catch (error) {
            if (reason!==undefined) {
                this.conflicts.add(normalized);
                this.state!.conflicts[normalized] = reason;
                await this.options.stateStore.save(this.state!);
            }
            throw error;
        }
    }

    private async initializeState(currentVersion:number, localFiles:string[], remoteFiles:string[]) {
        if (!this.state) {
            this.state = createSyncState(this.options.projectUri, currentVersion, false);
            await this.options.stateStore.save(this.state);
        }
        this.restoreConflicts();

        const paths = new Set([...localFiles, ...remoteFiles, ...Object.keys(this.state.files)]);
        for (const path of [...paths].sort()) {
            const normalized = normalizePath(path);
            if (this.conflicts.has(normalized)) { continue; }
            if (this.state.files[normalized]!==undefined) {
                await this.reconcilePath(normalized, 'local');
                continue;
            }
            await this.initializePath(normalized);
        }
        this.state.remoteVersion = currentVersion;
        this.state.initialized = true;
        await this.options.stateStore.save(this.state);
        if (this.conflicts.size!==0) {
            this.options.log(`Synchronization remains active; ${this.conflicts.size} conflicting path(s) are paused.`);
        }
    }

    private async initializePath(path:string) {
        const remoteEntry = this.options.remote.entry(path);
        if (remoteEntry?.type==='folder') { return; }
        const localContent = await this.options.local.read(path);
        const remoteContent = isRemoteFile(remoteEntry) ? await this.options.remote.read(path) : undefined;
        const localHash = localContent && sha256(localContent);
        const remoteHash = remoteContent && sha256(remoteContent);

        if (localHash===remoteHash) {
            if (localContent) {
                updateSyncCheckpoint(this.state!, path, localContent);
                await this.options.stateStore.save(this.state!);
            }
            return;
        }
        if (!localContent && remoteContent) {
            await this.options.local.write(path, remoteContent);
            updateSyncCheckpoint(this.state!, path, remoteContent);
            await this.options.stateStore.save(this.state!);
            this.logChange('pull', 'add', path, undefined, remoteContent);
            return;
        }

        await this.recordConflict(
            path,
            remoteContent
                ? 'Local and Overleaf content differ, but no common checkpoint exists.'
                : 'The local path has no matching Overleaf file and no common checkpoint exists.',
        );
    }

    private restoreConflicts() {
        for (const [path, reason] of Object.entries(this.state!.conflicts)) {
            if (this.conflicts.has(path)) { continue; }
            this.conflicts.add(path);
            this.options.onConflict(path, reason);
        }
    }

    private async recordConflict(path:string, reason:string) {
        this.conflicts.add(path);
        this.state!.conflicts[path] = reason;
        await this.options.stateStore.save(this.state!);
        this.options.onConflict(path, reason);
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
        for (const path of [...localFiles, ...remoteFiles]) {
            if (state.files[path]===undefined) { candidates.add(path); }
        }
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

    private async reconcileAfterReconnect() {
        if (this.stopped) { return; }
        const currentVersion = await this.options.remote.getCurrentVersion();
        await this.startupReconcile(
            currentVersion,
            await this.options.local.listFiles(),
            this.remoteFilePaths(),
        );
        this.options.log(`Realtime connection restored at Overleaf version ${currentVersion}.`);
    }

    private schedule(path:string, source:ChangeSource, actor?:string) {
        const normalized = normalizePath(path);
        if (this.stopped || this.shouldIgnore(normalized) || this.conflicts.has(normalized)) { return; }
        const previous = this.eventTimers.get(normalized);
        if (previous) { clearTimeout(previous.timer); }
        const actors = previous?.actors ?? new Set<string>();
        let unknownRemoteActor = previous?.unknownRemoteActor ?? false;
        if (source==='remote') {
            if (actor) { actors.add(actor); }
            else { unknownRemoteActor = true; }
        }
        const pending:PendingChange = {
            source:previous?.source==='local' || source==='local' ? 'local' : 'remote',
            actors,
            unknownRemoteActor,
            timer:setTimeout(() => {
                this.eventTimers.delete(normalized);
                if (this.stopped) { return; }
                const remoteActor = pending.unknownRemoteActor
                    ? undefined
                    : pending.actors.size===1
                        ? [...pending.actors][0]
                        : pending.actors.size>1
                            ? 'multiple Overleaf collaborators'
                            : undefined;
                this.queue = this.queue.then(() => this.reconcilePath(normalized, pending.source, remoteActor)).catch(error => {
                    this.options.log(`Failed to synchronize ${normalized}: ${error instanceof Error ? error.message : String(error)}`);
                });
            }, 250),
        };
        this.eventTimers.set(normalized, pending);
    }

    private enqueue<T>(operation:() => Promise<T>):Promise<T> {
        const result = this.queue.then(operation);
        this.queue = result.then(() => undefined, () => undefined);
        return result;
    }

    private async reconcilePath(path:string, source:ChangeSource, actor?:string):Promise<void> {
        const normalized = normalizePath(path);
        if (this.stopped || this.shouldIgnore(normalized) || this.conflicts.has(normalized)) { return; }
        const remoteEntry = this.options.remote.entry(normalized);
        if (remoteEntry?.type==='folder') { return; }
        const localContent = await this.options.local.read(normalized);
        const remoteContent = isRemoteFile(remoteEntry) ? await this.options.remote.read(normalized) : undefined;
        const baseHash = this.state!.files[normalized];
        const baseContent = readTextBase(this.state, normalized);
        const localHash = localContent && sha256(localContent);
        const remoteHash = remoteContent && sha256(remoteContent);

        if (localHash===remoteHash) {
            if (localHash!==baseHash) {
                if (localContent) { updateSyncCheckpoint(this.state!, normalized, localContent); }
                else { removeSyncCheckpoint(this.state!, normalized); }
                await this.options.stateStore.save(this.state!);
            }
            return;
        }

        const localChanged = localHash!==baseHash;
        const remoteChanged = remoteHash!==baseHash;
        if (localChanged && remoteChanged) {
            if (baseContent && localContent && remoteContent) {
                const merged = mergeText(baseContent, localContent, remoteContent);
                if (merged.status==='merged' && merged.content) {
                    await this.options.local.write(normalized, merged.content);
                    await this.options.remote.write(normalized, merged.content);
                    updateSyncCheckpoint(this.state!, normalized, merged.content);
                    await this.options.stateStore.save(this.state!);
                    this.logChange('merge', 'update', normalized, baseContent, merged.content, actor);
                    return;
                }
            }
            const reason = 'Both local and Overleaf content changed since the last synchronized checkpoint.';
            await this.recordConflict(normalized, reason);
            return;
        }

        if (source==='remote' && localChanged && !remoteChanged) {
            return;
        }

        if (localChanged || (!remoteChanged && source==='local')) {
            let pushedContent = localContent;
            if (!localContent) {
                if (remoteEntry) {
                    await this.options.remote.remove(normalized);
                }
                removeSyncCheckpoint(this.state!, normalized);
            } else {
                await this.options.remote.write(normalized, localContent);
                const synchronized = await this.options.remote.read(normalized);
                if (sha256(synchronized)!==sha256(localContent)) {
                    await this.options.local.write(normalized, synchronized);
                }
                pushedContent = synchronized;
                updateSyncCheckpoint(this.state!, normalized, synchronized);
            }
            await this.options.stateStore.save(this.state!);
            if (!localContent && remoteEntry) {
                this.logChange('push', 'delete', normalized, baseContent ?? remoteContent, undefined, actor);
            } else if (localContent) {
                this.logChange(
                    'push', remoteEntry ? 'update' : 'add', normalized,
                    baseContent ?? remoteContent, pushedContent, actor,
                );
            }
            return;
        }

        if (!remoteContent) {
            if (localContent) {
                await this.options.local.remove(normalized);
            }
            removeSyncCheckpoint(this.state!, normalized);
        } else {
            await this.options.local.write(normalized, remoteContent);
            updateSyncCheckpoint(this.state!, normalized, remoteContent);
        }
        await this.options.stateStore.save(this.state!);
        if (!remoteContent && localContent) {
            this.logChange('pull', 'delete', normalized, baseContent ?? localContent, undefined, actor);
        } else if (remoteContent) {
            this.logChange(
                'pull', localContent ? 'update' : 'add', normalized,
                baseContent ?? localContent, remoteContent, actor,
            );
        }
    }

    private logChange(
        direction:'push'|'pull'|'merge',
        operation:'add'|'update'|'delete',
        path:string,
        before?:Uint8Array,
        after?:Uint8Array,
        actor?:string,
    ):void {
        const summary = describeContentChange(before, after);
        const source = direction==='push'
            ? 'local filesystem'
            : direction==='pull'
                ? actor ?? 'Overleaf'
                : `local filesystem + ${actor ?? 'Overleaf'}`;
        this.options.log([
            `[${direction}] ${operation} ${JSON.stringify(path)}`,
            summary,
            `source=${source}`,
        ].filter(Boolean).join('; '));
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
