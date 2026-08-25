import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {ProjectFileTreeDiffResponseSchema} from '../src/api/base';
import {FileSyncStateStore} from '../src/node/syncStateStore';
import type {RemoteEntry} from '../src/sync/remoteProject';
import {createSyncState, sha256, type LocalReplicaSyncState, updateSyncCheckpoint} from '../src/sync/checkpoint';
import {
    SyncEngine,
    type RemoteReplica,
    type ReplicaFileSystem,
    type SyncStateStore,
} from '../src/sync/syncEngine';

class MemoryLocal implements ReplicaFileSystem {
    private changeHandler?:(path:string) => void;
    constructor(readonly files:Map<string,Uint8Array>) {}
    async listFiles() { return [...this.files.keys()]; }
    async read(path:string) { return this.files.get(path); }
    async write(path:string, content:Uint8Array) { this.files.set(path, content); }
    async remove(path:string) { this.files.delete(path); }
    async watch(onChange:(path:string) => void) {
        this.changeHandler = onChange;
        return async () => {
            if (this.changeHandler===onChange) { this.changeHandler = undefined; }
        };
    }
    change(path:string, content:Uint8Array) {
        this.files.set(path, content);
        this.changeHandler?.(path);
    }
}

class MemoryRemote implements RemoteReplica {
    private reconnectHandler?:() => void;
    private changeHandler?:(change:{path:string; previousPath?:string; actor?:string}) => void;
    failReadPath?:string;
    emitOnWrite = false;
    constructor(
        readonly files:Map<string,Uint8Array>,
        public version:number,
        public diff:ProjectFileTreeDiffResponseSchema,
    ) {}
    listEntries():RemoteEntry[] {
        return [...this.files.keys()].map((path, index) => ({
            path,
            type:'doc',
            entity:{_id:String(index), name:path.split('/').at(-1)!, _type:'doc'},
        }));
    }
    entry(path:string) { return this.listEntries().find(entry => entry.path===path); }
    async read(path:string) {
        if (path===this.failReadPath) { throw new Error(`read failed for ${path}`); }
        return this.files.get(path)!;
    }
    async write(path:string, content:Uint8Array) {
        this.files.set(path, content);
        if (this.emitOnWrite) { setTimeout(() => this.change(path), 10); }
    }
    async remove(path:string) { this.files.delete(path); }
    async getCurrentVersion() { return this.version; }
    async getFileTreeDiff() { return this.diff; }
    onChange(handler:(change:{path:string; previousPath?:string; actor?:string}) => void) {
        this.changeHandler = handler;
        return () => {
            if (this.changeHandler===handler) { this.changeHandler = undefined; }
        };
    }
    onReconnect(handler:() => void) {
        this.reconnectHandler = handler;
        return () => {
            if (this.reconnectHandler===handler) { this.reconnectHandler = undefined; }
        };
    }
    change(path:string, actor?:string) { this.changeHandler?.({path, actor}); }
    reconnect() { this.reconnectHandler?.(); }
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
const roots:string[] = [];

afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(roots.splice(0).map(root => rm(root, {recursive:true, force:true})));
});

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
        const logs:string[] = [];
        const engine = new SyncEngine({
            projectUri:'overleaf://project', local, remote, stateStore:store,
            ignore:()=>false, log:message=>logs.push(message), onConflict:path=>conflicts.push(path),
        });

        await engine.start();
        expect(conflicts).toEqual(['/a.tex']);
        expect(engine.getConflicts()).toEqual(['/a.tex']);
        expect(text(remote.files.get('/b.tex'))).toBe('updated\n');
        expect(store.saves.at(-1)?.files['/b.tex']).toBeDefined();
        expect(store.saves.at(-1)?.remoteVersion).toBe(2);
        expect(logs).toContain('[push] update "/b.tex"; lines 1; source=local filesystem');

        await engine.resolveConflict('/a.tex', 'local');
        expect(engine.getConflicts()).toEqual([]);
        expect(text(remote.files.get('/a.tex'))).toBe('local\n');
        expect(store.saves.at(-1)?.files['/a.tex']).toBeDefined();
        await engine.stop();
    });

    it('logs successful remote updates and deletions by path', async () => {
        const state = createSyncState('overleaf://project', 1);
        updateSyncCheckpoint(state, '/updated.tex', bytes('base\n'));
        updateSyncCheckpoint(state, '/deleted.tex', bytes('base\n'));
        const local = new MemoryLocal(new Map([
            ['/updated.tex', bytes('base\n')],
            ['/deleted.tex', bytes('base\n')],
        ]));
        const remote = new MemoryRemote(
            new Map([['/updated.tex', bytes('remote\n')]]),
            2,
            {diff:[
                {pathname:'/updated.tex', operation:'edited'},
                {pathname:'/deleted.tex', operation:'removed'},
            ]},
        );
        const logs:string[] = [];
        const engine = new SyncEngine({
            projectUri:'overleaf://project', local, remote, stateStore:new MemoryState(state),
            ignore:()=>false, log:message=>logs.push(message), onConflict:()=>{},
        });

        await engine.start();

        expect(text(local.files.get('/updated.tex'))).toBe('remote\n');
        expect(local.files.has('/deleted.tex')).toBe(false);
        expect(logs).toContain('[pull] update "/updated.tex"; lines 1; source=Overleaf');
        expect(logs).toContain('[pull] delete "/deleted.tex"; removed lines 1; source=Overleaf');
        await engine.stop();
    });

    it('rebuilds missing state per path without choosing a winner for divergent content', async () => {
        const local = new MemoryLocal(new Map([
            ['/same.tex', bytes('same\n')],
            ['/different.tex', bytes('local\n')],
            ['/local-only.tex', bytes('local only\n')],
        ]));
        const remote = new MemoryRemote(new Map([
            ['/same.tex', bytes('same\n')],
            ['/different.tex', bytes('remote\n')],
            ['/remote-only.tex', bytes('remote only\n')],
        ]), 7, {diff:[]});
        const store = new MemoryState();
        const conflicts:string[] = [];
        const engine = new SyncEngine({
            projectUri:'overleaf://project', local, remote, stateStore:store,
            ignore:()=>false, log:()=>{}, onConflict:path=>conflicts.push(path),
        });

        await engine.start();

        expect(text(local.files.get('/remote-only.tex'))).toBe('remote only\n');
        expect(remote.files.has('/local-only.tex')).toBe(false);
        expect(text(local.files.get('/different.tex'))).toBe('local\n');
        expect(text(remote.files.get('/different.tex'))).toBe('remote\n');
        expect(conflicts.sort()).toEqual(['/different.tex', '/local-only.tex']);
        expect(store.saves.at(-1)?.files['/same.tex']).toBeDefined();
        expect(store.saves.at(-1)?.files['/remote-only.tex']).toBeDefined();
        expect(store.saves.at(-1)?.initialized).toBe(true);
        await engine.stop();
    });

    it('safely rebuilds only the missing paths when sharded state is incomplete', async () => {
        const state = createSyncState('overleaf://project', 7, false);
        updateSyncCheckpoint(state, '/intact.tex', bytes('intact\n'));
        const local = new MemoryLocal(new Map([
            ['/intact.tex', bytes('updated intact\n')],
            ['/local-only.tex', bytes('local only\n')],
        ]));
        const remote = new MemoryRemote(new Map([
            ['/intact.tex', bytes('intact\n')],
            ['/remote-only.tex', bytes('remote only\n')],
        ]), 7, {diff:[]});
        const store = new MemoryState(state);
        const engine = new SyncEngine({
            projectUri:'overleaf://project', local, remote, stateStore:store,
            ignore:()=>false, log:()=>{}, onConflict:()=>{},
        });

        await engine.start();

        expect(remote.files.has('/local-only.tex')).toBe(false);
        expect(engine.getConflicts()).toEqual(['/local-only.tex']);
        expect(text(remote.files.get('/intact.tex'))).toBe('updated intact\n');
        expect(text(local.files.get('/remote-only.tex'))).toBe('remote only\n');
        expect(store.saves.at(-1)?.initialized).toBe(true);
        await engine.stop();
    });

    it('keeps a rebuilt local-only conflict across a second store load', async () => {
        const root = await mkdtemp(join(tmpdir(), 'leafrelay-corrupt-restart-'));
        roots.push(root);
        const projectUri = 'overleaf://project';
        const seededState = createSyncState(projectUri, 1);
        updateSyncCheckpoint(seededState, '/local-only.tex', bytes('old checkpoint\n'));
        const seededStore = new FileSyncStateStore(root, projectUri);
        await seededStore.save(seededState);
        const pathHash = sha256(bytes('/local-only.tex'));
        const recordPath = join(root, '.overleaf', 'sync', 'paths', pathHash.slice(0, 2), `${pathHash}.json`);
        await writeFile(recordPath, '{damaged');

        const local = new MemoryLocal(new Map([['/local-only.tex', bytes('local work\n')]]));
        const remote = new MemoryRemote(new Map(), 1, {diff:[]});
        const firstEngine = new SyncEngine({
            projectUri, local, remote, stateStore:new FileSyncStateStore(root, projectUri),
            ignore:()=>false, log:()=>{}, onConflict:()=>{},
        });
        await firstEngine.start();
        expect(firstEngine.getConflicts()).toEqual(['/local-only.tex']);
        expect(remote.files.has('/local-only.tex')).toBe(false);
        await firstEngine.stop();

        const reloadedStore = new FileSyncStateStore(root, projectUri);
        const reloaded = await reloadedStore.load();
        expect(reloaded?.initialized).toBe(true);
        expect(reloaded?.conflicts['/local-only.tex']).toContain('no common checkpoint');
        const secondEngine = new SyncEngine({
            projectUri, local, remote, stateStore:reloadedStore,
            ignore:()=>false, log:()=>{}, onConflict:()=>{},
        });
        await secondEngine.start();
        expect(secondEngine.getConflicts()).toEqual(['/local-only.tex']);
        expect(remote.files.has('/local-only.tex')).toBe(false);
        await secondEngine.stop();
    });

    it('reconciles changes that happened while the realtime connection was down', async () => {
        const state = createSyncState('overleaf://project', 1);
        updateSyncCheckpoint(state, '/paper.tex', bytes('base\n'));
        const local = new MemoryLocal(new Map([['/paper.tex', bytes('base\n')]]));
        const remote = new MemoryRemote(
            new Map([['/paper.tex', bytes('base\n')]]),
            1,
            {diff:[]},
        );
        const logs:string[] = [];
        const engine = new SyncEngine({
            projectUri:'overleaf://project', local, remote, stateStore:new MemoryState(state),
            ignore:()=>false, log:message=>logs.push(message), onConflict:()=>{},
        });

        await engine.start();
        remote.files.set('/paper.tex', bytes('changed while disconnected\n'));
        remote.version = 2;
        remote.diff = {diff:[{pathname:'/paper.tex', operation:'edited'}]};
        remote.reconnect();
        await vi.waitFor(() => expect(text(local.files.get('/paper.tex'))).toBe('changed while disconnected\n'));
        await engine.stop();

        expect(text(local.files.get('/paper.tex'))).toBe('changed while disconnected\n');
        expect(logs).toContain('Realtime connection restored at Overleaf version 2.');
    });

    it('unsubscribes from remote changes when the replica stops', async () => {
        const state = createSyncState('overleaf://project', 1);
        updateSyncCheckpoint(state, '/paper.tex', bytes('base\n'));
        const local = new MemoryLocal(new Map([['/paper.tex', bytes('base\n')]]));
        const remote = new MemoryRemote(new Map([['/paper.tex', bytes('base\n')]]), 1, {diff:[]});
        const engine = new SyncEngine({
            projectUri:'overleaf://project', local, remote, stateStore:new MemoryState(state),
            ignore:()=>false, log:()=>{}, onConflict:()=>{},
        });

        await engine.start();
        await engine.stop();
        remote.files.set('/paper.tex', bytes('remote after stop\n'));
        remote.change('/paper.tex', 'Remote User');

        expect(text(local.files.get('/paper.tex'))).toBe('base\n');
    });

    it('does not let delayed remote echoes reverse a stable local write', async () => {
        const state = createSyncState('overleaf://project', 1);
        updateSyncCheckpoint(state, '/paper.tex', bytes('base\n'));
        const local = new MemoryLocal(new Map([['/paper.tex', bytes('base\n')]]));
        const remote = new MemoryRemote(new Map([['/paper.tex', bytes('base\n')]]), 1, {diff:[]});
        remote.emitOnWrite = true;
        const store = new MemoryState(state);
        const logs:string[] = [];
        const engine = new SyncEngine({
            projectUri:'overleaf://project', local, remote, stateStore:store,
            ignore:()=>false, log:message=>logs.push(message), onConflict:()=>{},
        });

        await engine.start();
        local.change('/paper.tex', bytes('local\n'));
        await vi.waitFor(() => expect(logs).toContain('[push] update "/paper.tex"; lines 1; source=local filesystem'));
        const savesAfterPush = store.saves.length;
        await new Promise(resolve => setTimeout(resolve, 350));
        expect(store.saves).toHaveLength(savesAfterPush);

        remote.files.set('/paper.tex', bytes('remote later\n'));
        remote.change('/paper.tex', 'Remote User');
        await vi.waitFor(() => expect(text(local.files.get('/paper.tex'))).toBe('remote later\n'));
        await engine.stop();
    });

    it('does not push transient local content in response to a stale remote event', async () => {
        const state = createSyncState('overleaf://project', 1);
        updateSyncCheckpoint(state, '/paper.tex', bytes('base\n'));
        const local = new MemoryLocal(new Map([['/paper.tex', bytes('base\n')]]));
        const remote = new MemoryRemote(new Map([['/paper.tex', bytes('base\n')]]), 1, {diff:[]});
        const logs:string[] = [];
        const engine = new SyncEngine({
            projectUri:'overleaf://project', local, remote, stateStore:new MemoryState(state),
            ignore:()=>false, log:message=>logs.push(message), onConflict:()=>{},
        });

        await engine.start();
        remote.change('/paper.tex');
        local.files.set('/paper.tex', bytes(''));
        await new Promise(resolve => setTimeout(resolve, 350));
        expect(text(remote.files.get('/paper.tex'))).toBe('base\n');
        expect(logs.some(log => log.startsWith('[push]'))).toBe(false);

        local.change('/paper.tex', bytes('finished local write\n'));
        await vi.waitFor(() => expect(text(remote.files.get('/paper.tex'))).toBe('finished local write\n'));
        await engine.stop();
    });

    it('keeps a pending local change when a stale remote echo arrives later', async () => {
        const state = createSyncState('overleaf://project', 1);
        updateSyncCheckpoint(state, '/paper.tex', bytes('base\n'));
        const local = new MemoryLocal(new Map([['/paper.tex', bytes('base\n')]]));
        const remote = new MemoryRemote(new Map([['/paper.tex', bytes('base\n')]]), 1, {diff:[]});
        const engine = new SyncEngine({
            projectUri:'overleaf://project', local, remote, stateStore:new MemoryState(state),
            ignore:()=>false, log:()=>{}, onConflict:()=>{},
        });

        await engine.start();
        local.change('/paper.tex', bytes('stable local change\n'));
        remote.change('/paper.tex');

        await vi.waitFor(() => expect(text(remote.files.get('/paper.tex'))).toBe('stable local change\n'));
        await engine.stop();
    });

    it('retains a conflict when retrying the path fails', async () => {
        const state = createSyncState('overleaf://project', 1);
        updateSyncCheckpoint(state, '/paper.tex', bytes('base\n'));
        state.conflicts['/paper.tex'] = 'Both sides changed.';
        const local = new MemoryLocal(new Map([['/paper.tex', bytes('local\n')]]));
        const remote = new MemoryRemote(new Map([['/paper.tex', bytes('remote\n')]]), 1, {diff:[]});
        const store = new MemoryState(state);
        const engine = new SyncEngine({
            projectUri:'overleaf://project', local, remote, stateStore:store,
            ignore:()=>false, log:()=>{}, onConflict:()=>{},
        });

        await engine.start();
        remote.failReadPath = '/paper.tex';
        await expect(engine.retry('/paper.tex')).rejects.toThrow('read failed');

        expect(engine.getConflicts()).toEqual(['/paper.tex']);
        expect(store.saves.at(-1)?.conflicts['/paper.tex']).toBe('Both sides changed.');
        await engine.stop();
    });

    it('attributes a debounced remote update to multiple collaborators', async () => {
        vi.useFakeTimers();
        try {
            const state = createSyncState('overleaf://project', 1);
            updateSyncCheckpoint(state, '/paper.tex', bytes('base\n'));
            const local = new MemoryLocal(new Map([['/paper.tex', bytes('base\n')]]));
            const remote = new MemoryRemote(new Map([['/paper.tex', bytes('base\n')]]), 1, {diff:[]});
            const logs:string[] = [];
            const engine = new SyncEngine({
                projectUri:'overleaf://project', local, remote, stateStore:new MemoryState(state),
                ignore:()=>false, log:message=>logs.push(message), onConflict:()=>{},
            });

            await engine.start();
            remote.files.set('/paper.tex', bytes('changed\n'));
            remote.change('/paper.tex', 'Alice');
            remote.change('/paper.tex', 'Bob');
            await vi.advanceTimersByTimeAsync(250);
            await engine.stop();

            expect(logs).toContain('[pull] update "/paper.tex"; lines 1; source=multiple Overleaf collaborators');
        } finally { vi.useRealTimers(); }
    });
});
