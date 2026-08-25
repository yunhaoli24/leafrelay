import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {createSyncState, updateSyncCheckpoint} from '../src/sync/checkpoint';
import {FileSyncStateStore} from '../src/node/syncStateStore';

const roots:string[] = [];
const bytes = (value:string) => new TextEncoder().encode(value);
const key = (value:string) => createHash('sha256').update(value).digest('hex');

function recordPath(root:string, path:string):string {
    const hash = key(path);
    return join(root, '.overleaf', 'sync', 'paths', hash.slice(0, 2), `${hash}.json`);
}

afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, {recursive:true, force:true})));
});

describe('FileSyncStateStore', () => {
    it('stores per-path records and plain-text merge bases without a monolithic state file', async () => {
        const root = await mkdtemp(join(tmpdir(), 'leafrelay-state-'));
        roots.push(root);
        await mkdir(join(root, '.overleaf'));
        await writeFile(join(root, '.overleaf', 'sync-state.json'), '{"legacy":true}\n');

        const state = createSyncState('overleaf://project', 42);
        updateSyncCheckpoint(state, '/main.tex', bytes('shared text\n'));
        updateSyncCheckpoint(state, '/figure.pdf', new Uint8Array([0, 1, 2]));
        state.conflicts['/draft.tex'] = 'No common checkpoint exists.';
        await new FileSyncStateStore(root, state.projectUri).save(state);

        const textRecord = JSON.parse(await readFile(recordPath(root, '/main.tex'), 'utf8'));
        const binaryRecord = JSON.parse(await readFile(recordPath(root, '/figure.pdf'), 'utf8'));
        const conflictRecord = JSON.parse(await readFile(recordPath(root, '/draft.tex'), 'utf8'));
        expect(textRecord).toMatchObject({path:'/main.tex', hash:key('shared text\n'), baseHash:key('shared text\n')});
        expect(await readFile(
            join(root, '.overleaf', 'sync', 'bases', textRecord.baseHash.slice(0, 2), `${textRecord.baseHash}.txt`),
            'utf8',
        )).toBe('shared text\n');
        expect(binaryRecord).toMatchObject({path:'/figure.pdf'});
        expect(binaryRecord.baseHash).toBeUndefined();
        expect(conflictRecord).toEqual({path:'/draft.tex', conflict:'No common checkpoint exists.'});
        await expect(readFile(join(root, '.overleaf', 'sync-state.json'))).rejects.toMatchObject({code:'ENOENT'});

        const restored = await new FileSyncStateStore(root, state.projectUri).load();
        expect(restored).toEqual(state);
    });

    it('rewrites only the record whose checkpoint changed', async () => {
        const root = await mkdtemp(join(tmpdir(), 'leafrelay-state-write-'));
        roots.push(root);
        const state = createSyncState('overleaf://project', 1);
        updateSyncCheckpoint(state, '/a.tex', bytes('a\n'));
        updateSyncCheckpoint(state, '/b.tex', bytes('b\n'));
        const store = new FileSyncStateStore(root, state.projectUri);
        await store.save(state);
        const untouchedPath = recordPath(root, '/b.tex');
        const untouchedModified = (await stat(untouchedPath)).mtimeMs;

        await new Promise(resolve => setTimeout(resolve, 20));
        updateSyncCheckpoint(state, '/a.tex', bytes('changed\n'));
        await store.save(state);

        expect((await stat(untouchedPath)).mtimeMs).toBe(untouchedModified);
    });

    it('isolates a damaged path record and removes interrupted temporary shards', async () => {
        const root = await mkdtemp(join(tmpdir(), 'leafrelay-state-damaged-'));
        roots.push(root);
        const state = createSyncState('overleaf://project', 1);
        updateSyncCheckpoint(state, '/damaged.tex', bytes('damaged\n'));
        updateSyncCheckpoint(state, '/intact.tex', bytes('intact\n'));
        const store = new FileSyncStateStore(root, state.projectUri);
        await store.save(state);

        const damagedRecord = recordPath(root, '/damaged.tex');
        const temporaryRecord = join(root, '.overleaf', 'sync', 'paths', 'ff', 'interrupted.tmp');
        const damagedBase = join(
            root, '.overleaf', 'sync', 'bases',
            state.files['/damaged.tex'].slice(0, 2), `${state.files['/damaged.tex']}.txt`,
        );
        const orphanHash = key('orphan base');
        const orphanBase = join(root, '.overleaf', 'sync', 'bases', orphanHash.slice(0, 2), `${orphanHash}.txt`);
        await writeFile(damagedRecord, '{not json');
        await mkdir(join(root, '.overleaf', 'sync', 'paths', 'ff'), {recursive:true});
        await writeFile(temporaryRecord, 'partial');
        await mkdir(join(root, '.overleaf', 'sync', 'bases', orphanHash.slice(0, 2)), {recursive:true});
        await writeFile(orphanBase, 'orphan base');

        const restoredStore = new FileSyncStateStore(root, state.projectUri);
        const restored = await restoredStore.load();

        expect(restored?.initialized).toBe(false);
        expect(restored?.files['/damaged.tex']).toBeUndefined();
        expect(restored?.files['/intact.tex']).toBe(state.files['/intact.tex']);
        await expect(stat(damagedRecord)).resolves.toBeDefined();
        await expect(stat(temporaryRecord)).rejects.toMatchObject({code:'ENOENT'});
        await expect(stat(damagedBase)).rejects.toMatchObject({code:'ENOENT'});
        await expect(stat(orphanBase)).rejects.toMatchObject({code:'ENOENT'});

        updateSyncCheckpoint(restored!, '/damaged.tex', bytes('rebuilt\n'));
        restored!.initialized = true;
        await restoredStore.save(restored!);
        expect(JSON.parse(await readFile(damagedRecord, 'utf8'))).toMatchObject({
            path:'/damaged.tex',
            hash:key('rebuilt\n'),
        });
    });
});
