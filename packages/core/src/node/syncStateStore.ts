import {randomUUID} from 'node:crypto';
import {mkdir, readFile, readdir, rename, rm, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {
    SYNC_STATE_SCHEMA_VERSION,
    sha256,
    type LocalReplicaSyncState,
} from '../sync/checkpoint';
import type {SyncStateStore} from '../sync/syncEngine';

interface StateFormat {
    schemaVersion:number;
    projectUri:string;
}

interface StateCursor {
    remoteVersion:number;
    initialized:boolean;
}

interface PathRecord {
    path:string;
    hash?:string;
    baseHash?:string;
    conflict?:string;
}

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const encoder = new TextEncoder();

function json(value:unknown):string {
    return `${JSON.stringify(value, null, 2)}\n`;
}

function pathKey(path:string):string {
    return sha256(encoder.encode(path));
}

async function readJson(path:string):Promise<unknown> {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

async function listFiles(directory:string):Promise<string[]> {
    const result:string[] = [];
    const visit = async (current:string) => {
        let entries;
        try {
            entries = await readdir(current, {withFileTypes:true});
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code==='ENOENT') { return; }
            throw error;
        }
        for (const entry of entries) {
            const path = join(current, entry.name);
            if (entry.isDirectory()) { await visit(path); }
            else if (entry.isFile()) { result.push(path); }
        }
    };
    await visit(directory);
    return result;
}

async function atomicWrite(path:string, content:string|Uint8Array):Promise<void> {
    await mkdir(dirname(path), {recursive:true});
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporary, content);
        await rename(temporary, path);
    } finally {
        await rm(temporary, {force:true});
    }
}

function parseFormat(value:unknown, projectUri:string):value is StateFormat {
    if (typeof value!=='object' || value===null) { return false; }
    const format = value as Partial<StateFormat>;
    return format.schemaVersion===SYNC_STATE_SCHEMA_VERSION && format.projectUri===projectUri;
}

function parseCursor(value:unknown):value is StateCursor {
    if (typeof value!=='object' || value===null) { return false; }
    const cursor = value as Partial<StateCursor>;
    return Number.isInteger(cursor.remoteVersion) && cursor.remoteVersion!>=0 &&
        typeof cursor.initialized==='boolean';
}

function parsePathRecord(value:unknown):value is PathRecord {
    if (typeof value!=='object' || value===null) { return false; }
    const record = value as Partial<PathRecord>;
    if (typeof record.path!=='string' || !record.path.startsWith('/')) { return false; }
    if (record.hash!==undefined && (typeof record.hash!=='string' || !HASH_PATTERN.test(record.hash))) { return false; }
    if (record.baseHash!==undefined &&
        (typeof record.baseHash!=='string' || !HASH_PATTERN.test(record.baseHash) || record.hash!==record.baseHash)) {
        return false;
    }
    if (record.conflict!==undefined && typeof record.conflict!=='string') { return false; }
    return record.hash!==undefined || record.conflict!==undefined;
}

function createRecord(state:LocalReplicaSyncState, path:string):PathRecord|undefined {
    const hash = state.files[path];
    const textBase = state.textBases[path];
    const conflict = state.conflicts[path];
    if (hash===undefined && conflict===undefined) { return undefined; }
    return {
        path,
        ...(hash===undefined ? {} : {hash}),
        ...(textBase===undefined ? {} : {baseHash:hash}),
        ...(conflict===undefined ? {} : {conflict}),
    };
}

export class FileSyncStateStore implements SyncStateStore {
    private readonly legacyPath:string;
    private readonly syncDirectory:string;
    private readonly formatPath:string;
    private readonly cursorPath:string;
    private readonly pathsDirectory:string;
    private readonly basesDirectory:string;
    private persistedRecords = new Map<string,string>();
    private persistedCursor?:string;
    private invalidRecordPaths = new Set<string>();
    private initialized = false;

    constructor(directory:string, private readonly projectUri:string) {
        const overleafDirectory = resolve(directory, '.overleaf');
        this.legacyPath = join(overleafDirectory, 'sync-state.json');
        this.syncDirectory = join(overleafDirectory, 'sync');
        this.formatPath = join(this.syncDirectory, 'format.json');
        this.cursorPath = join(this.syncDirectory, 'cursor.json');
        this.pathsDirectory = join(this.syncDirectory, 'paths');
        this.basesDirectory = join(this.syncDirectory, 'bases');
    }

    async load():Promise<LocalReplicaSyncState|undefined> {
        this.invalidRecordPaths.clear();
        try {
            const format = await readJson(this.formatPath);
            const cursor = await readJson(this.cursorPath);
            if (!parseFormat(format, this.projectUri) || !parseCursor(cursor)) { return undefined; }

            const state:LocalReplicaSyncState = {
                schemaVersion:SYNC_STATE_SCHEMA_VERSION,
                projectUri:this.projectUri,
                remoteVersion:cursor.remoteVersion,
                initialized:cursor.initialized,
                files:{},
                textBases:{},
                conflicts:{},
            };
            const records = new Map<string,string>();
            const referencedBases = new Set<string>();
            let stateIncomplete = false;
            for (const recordPath of await listFiles(this.pathsDirectory)) {
                const record = await this.loadRecord(recordPath);
                if (!record) {
                    if (recordPath.endsWith('.json')) {
                        this.invalidRecordPaths.add(recordPath);
                        stateIncomplete = true;
                    } else {
                        await rm(recordPath, {force:true});
                    }
                    continue;
                }
                if (record.hash!==undefined) { state.files[record.path] = record.hash; }
                if (record.baseHash!==undefined) {
                    let textBase:string;
                    try {
                        textBase = await readFile(this.basePath(record.baseHash), 'utf8');
                    } catch (error) {
                        if ((error as NodeJS.ErrnoException).code==='ENOENT') {
                            this.invalidRecordPaths.add(recordPath);
                            stateIncomplete = true;
                            delete state.files[record.path];
                            continue;
                        }
                        throw error;
                    }
                    if (sha256(encoder.encode(textBase))!==record.baseHash) {
                        this.invalidRecordPaths.add(recordPath);
                        stateIncomplete = true;
                        delete state.files[record.path];
                        continue;
                    }
                    state.textBases[record.path] = textBase;
                    referencedBases.add(record.baseHash);
                }
                if (record.conflict!==undefined) { state.conflicts[record.path] = record.conflict; }
                records.set(record.path, json(record));
            }
            if (stateIncomplete) { state.initialized = false; }
            await this.removeOrphanBases(referencedBases);
            this.persistedRecords = records;
            this.persistedCursor = json(cursor);
            this.initialized = true;
            return state;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code==='ENOENT' || error instanceof SyntaxError) { return undefined; }
            throw error;
        }
    }

    async save(state:LocalReplicaSyncState):Promise<void> {
        if (state.projectUri!==this.projectUri || state.schemaVersion!==SYNC_STATE_SCHEMA_VERSION) {
            throw new Error('Cannot persist synchronization state for a different project or schema.');
        }
        if (!this.initialized) { await this.initializeStorage(); }

        const paths = new Set([
            ...this.persistedRecords.keys(),
            ...Object.keys(state.files),
            ...Object.keys(state.conflicts),
        ]);
        const obsoleteBases = new Set<string>();
        for (const path of [...paths].sort()) {
            const record = createRecord(state, path);
            const serialized = record && json(record);
            const previous = this.persistedRecords.get(path);
            if (serialized===previous) { continue; }
            if (previous) {
                const previousRecord = JSON.parse(previous) as PathRecord;
                if (previousRecord.baseHash) { obsoleteBases.add(previousRecord.baseHash); }
            }
            if (!record || !serialized) {
                await rm(this.recordPath(path), {force:true});
                this.persistedRecords.delete(path);
                continue;
            }
            if (record.baseHash) {
                const textBase = state.textBases[path];
                if (textBase===undefined || sha256(encoder.encode(textBase))!==record.baseHash) {
                    throw new Error(`Text checkpoint does not match its content hash: ${path}`);
                }
                await this.writeBase(record.baseHash, textBase);
            }
            const destination = this.recordPath(path);
            await atomicWrite(destination, serialized);
            this.invalidRecordPaths.delete(destination);
            this.persistedRecords.set(path, serialized);
        }

        const cursor = json({remoteVersion:state.remoteVersion, initialized:state.initialized});
        if (cursor!==this.persistedCursor) {
            await atomicWrite(this.cursorPath, cursor);
            this.persistedCursor = cursor;
        }
        if (state.initialized) {
            await Promise.all([...this.invalidRecordPaths].map(path => rm(path, {force:true})));
            this.invalidRecordPaths.clear();
        }
        await rm(this.legacyPath, {force:true});
        await this.removeObsoleteBases(state, obsoleteBases);
    }

    private async initializeStorage():Promise<void> {
        await rm(this.syncDirectory, {recursive:true, force:true});
        await mkdir(this.pathsDirectory, {recursive:true});
        await mkdir(this.basesDirectory, {recursive:true});
        await atomicWrite(this.formatPath, json({
            schemaVersion:SYNC_STATE_SCHEMA_VERSION,
            projectUri:this.projectUri,
        }));
        this.persistedRecords.clear();
        this.persistedCursor = undefined;
        this.invalidRecordPaths.clear();
        this.initialized = true;
    }

    private recordPath(path:string):string {
        const key = pathKey(path);
        return join(this.pathsDirectory, key.slice(0, 2), `${key}.json`);
    }

    private async loadRecord(recordPath:string):Promise<PathRecord|undefined> {
        if (!recordPath.endsWith('.json')) { return undefined; }
        try {
            const record = await readJson(recordPath);
            if (!parsePathRecord(record) || recordPath!==this.recordPath(record.path)) { return undefined; }
            return record;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code==='ENOENT' || error instanceof SyntaxError) { return undefined; }
            throw error;
        }
    }

    private basePath(hash:string):string {
        return join(this.basesDirectory, hash.slice(0, 2), `${hash}.txt`);
    }

    private async writeBase(hash:string, content:string):Promise<void> {
        const path = this.basePath(hash);
        try {
            if (sha256(encoder.encode(await readFile(path, 'utf8')))===hash) { return; }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code!=='ENOENT') { throw error; }
        }
        await atomicWrite(path, content);
    }

    private async removeObsoleteBases(state:LocalReplicaSyncState, candidates:Set<string>):Promise<void> {
        if (candidates.size===0) { return; }
        const referenced = new Set<string>();
        for (const [path, textBase] of Object.entries(state.textBases)) {
            if (textBase!==undefined && state.files[path]!==undefined) { referenced.add(state.files[path]); }
        }
        for (const hash of candidates) {
            if (!referenced.has(hash)) { await rm(this.basePath(hash), {force:true}); }
        }
    }

    private async removeOrphanBases(referencedHashes:Set<string>):Promise<void> {
        const referencedPaths = new Set([...referencedHashes].map(hash => this.basePath(hash)));
        for (const path of await listFiles(this.basesDirectory)) {
            if (!referencedPaths.has(path)) { await rm(path, {force:true}); }
        }
    }
}
