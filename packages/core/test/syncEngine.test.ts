import {describe, expect, it} from 'vitest';
import type {ProjectFileTreeDiffResponseSchema} from '../src/api/base';
import type {RemoteEntry} from '../src/sync/remoteProject';
import {createSyncState, type LocalReplicaSyncState, updateSyncCheckpoint} from '../src/sync/checkpoint';
import {
    SyncEngine,
    type RemoteReplica,
    type ReplicaFileSystem,
    type SyncStateStore,
} from '../src/sync/syncEngine';

class MemoryLocal implements ReplicaFileSystem {
    constructor(readonly files:Map<string,Uint8Array>) {}
    async listFiles() { return [...this.files.keys()]; }
    async read(path:string) { return this.files.get(path); }
    async write(path:string, content:Uint8Array) { this.files.set(path, content); }
    async remove(path:string) { this.files.delete(path); }
    async watch() { return async () => {}; }
}

class MemoryRemote implements RemoteReplica {
    constructor(
        readonly files:Map<string,Uint8Array>,
        readonly version:number,
        readonly diff:ProjectFileTreeDiffResponseSchema,
    ) {}
    listEntries():RemoteEntry[] {
        return [...this.files.keys()].map((path, index) => ({
            path,
            type:'doc',
            entity:{_id:String(index), name:path.split('/').at(-1)!, _type:'doc'},
        }));
    }
    entry(path:string) { return this.listEntries().find(entry => entry.path===path); }
    async read(path:string) { return this.files.get(path)!; }
    async write(path:string, content:Uint8Array) { this.files.set(path, content); }
    async remove(path:string) { this.files.delete(path); }
    async getCurrentVersion() { return this.version; }
    async getFileTreeDiff() { return this.diff; }
    onChange() {}
}

class MemoryState implements SyncStateStore {
    saves:LocalReplicaSyncState[] = [];
    constructor(private state?:LocalReplicaSyncState) {}
    async load() { return this.state; }
    async save(state:LocalReplicaSyncState) {
        this.state = structuredClone(state);
        this.saves.push(structuredClone(state));
    }
}

const bytes = (value:string) => new TextEncoder().encode(value);
const text = (value:Uint8Array|undefined) => value && new TextDecoder().decode(value);

describe('SyncEngine', () => {
    it('three-way merges non-overlapping local and remote edits', async () => {
        const state = createSyncState('overleaf://project', 1);
        updateSyncCheckpoint(state, '/paper.tex', bytes('first\nmiddle\nthird\n'));
        const local = new MemoryLocal(new Map([['/paper.tex', bytes('FIRST\nmiddle\nthird\n')]]));
        const remote = new MemoryRemote(
            new Map([['/paper.tex', bytes('first\nmiddle\nTHIRD\n')]]),
            2,
            {diff:[{pathname:'/paper.tex', operation:'edited'}]},
        );
        const store = new MemoryState(state);
        const engine = new SyncEngine({
            projectUri:'overleaf://project', local, remote, stateStore:store,
            ignore:()=>false, log:()=>{}, onConflict:()=>{},
        });

        await engine.start();
        expect(text(local.files.get('/paper.tex'))).toBe('FIRST\nmiddle\nTHIRD\n');
        expect(text(remote.files.get('/paper.tex'))).toBe('FIRST\nmiddle\nTHIRD\n');
        await engine.stop();
    });

    it('checkpoints successful paths even when another path conflicts', async () => {
        const state = createSyncState('overleaf://project', 1);
        updateSyncCheckpoint(state, '/a.tex', bytes('base\n'));
        updateSyncCheckpoint(state, '/b.tex', bytes('base\n'));
        const local = new MemoryLocal(new Map([
            ['/a.tex', bytes('local\n')],
            ['/b.tex', bytes('updated\n')],
        ]));
        const remote = new MemoryRemote(new Map([
            ['/a.tex', bytes('remote\n')],
            ['/b.tex', bytes('base\n')],
        ]), 2, {diff:[{pathname:'/a.tex', operation:'edited'}]});
        const store = new MemoryState(state);
        const conflicts:string[] = [];
        const engine = new SyncEngine({
            projectUri:'overleaf://project', local, remote, stateStore:store,
            ignore:()=>false, log:()=>{}, onConflict:path=>conflicts.push(path),
        });

        await engine.start();
        expect(conflicts).toEqual(['/a.tex']);
        expect(engine.getConflicts()).toEqual(['/a.tex']);
        expect(text(remote.files.get('/b.tex'))).toBe('updated\n');
        expect(store.saves.at(-1)?.files['/b.tex']).toBeDefined();
        expect(store.saves.at(-1)?.remoteVersion).toBe(2);

        await engine.resolveConflict('/a.tex', 'local');
        expect(engine.getConflicts()).toEqual([]);
        expect(text(remote.files.get('/a.tex'))).toBe('local\n');
        expect(store.saves.at(-1)?.files['/a.tex']).toBeDefined();
        await engine.stop();
    });
});
