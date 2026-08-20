import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {RunningServe, StartServeOptions} from '@leafrelay/core';
import {ReplicaAlreadyActiveError, ReplicaRegistry} from '../src/replicaRegistry';

const roots:string[] = [];

afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, {recursive:true, force:true})));
});

async function projectDirectory(name:string):Promise<string> {
    const root = await mkdtemp(join(tmpdir(), `leafrelay-${name}-`));
    roots.push(root);
    await mkdir(join(root, '.overleaf'));
    await writeFile(join(root, '.overleaf', 'settings.json'), JSON.stringify({
        uri:'overleaf-workshop://www.overleaf.com/Test?user%3Du1%26project%3Dp1',
        serverName:'www.overleaf.com',
        projectName:'Test',
        localReplica:{settings:{}},
    }));
    return root;
}

describe('ReplicaRegistry', () => {
    it('shares the same real path and rejects a second writable root for one project', async () => {
        const firstRoot = await projectDirectory('first');
        const secondRoot = await projectDirectory('second');
        const stop = vi.fn(async () => {});
        const start = vi.fn(async (directory:string, _options:StartServeOptions):Promise<RunningServe> => ({
            root:directory,
            serverName:'www.overleaf.com',
            projectId:'p1',
            projectName:'Test',
            conflicts:() => [],
            resolveConflict:async () => {},
            retry:async () => {},
            stop,
        }));
        const registry = new ReplicaRegistry({status:()=>{}, conflict:()=>{}, empty:()=>{}, log:()=>{}}, start);

        const [first, shared] = await Promise.all([
            registry.attach('client-1', {directory:firstRoot}),
            registry.attach('client-2', {directory:firstRoot}),
        ]);
        expect(shared.replicaId).toBe(first.replicaId);
        expect([first.shared, shared.shared].sort()).toEqual([false, true]);
        expect(start).toHaveBeenCalledTimes(1);
        await expect(registry.attach('client-3', {directory:secondRoot})).rejects.toBeInstanceOf(ReplicaAlreadyActiveError);

        await registry.stopAll();
        expect(stop).toHaveBeenCalledOnce();
    });
});
