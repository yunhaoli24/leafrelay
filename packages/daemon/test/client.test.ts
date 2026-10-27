import {randomUUID} from 'node:crypto';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {createServer, type Socket} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {RPC_METHOD, type ReplicaAttachResult} from '@leafrelay/protocol';
import {LeafRelayDaemonClient} from '../src/client';
import {daemonPaths} from '../src/paths';
import {createSocketRpcConnection} from '../src/transport';

const cleanup:Array<() => Promise<void>> = [];
afterEach(async () => {
    for (const dispose of cleanup.splice(0).reverse()) { await dispose(); }
});

async function daemonPeer() {
    const home = await mkdtemp(join(tmpdir(), 'leafrelay-client-'));
    const environment = {...process.env, LEAFRELAY_HOME:home};
    const paths = daemonPaths(environment);
    const sockets:Socket[] = [];
    const attached:string[] = [];
    const projectOpens:string[] = [];
    const retryIds:string[] = [];
    let holdAttach = false;
    let interruptRestore = false;
    let mutations = 0;
    const server = createServer(socket => {
        sockets.push(socket);
        const rpc = createSocketRpcConnection(socket);
        rpc.onRequest(RPC_METHOD.initialize, () => ({daemonVersion:'test', protocolVersion:1, pid:process.pid, startedAt:''}));
        rpc.onRequest(RPC_METHOD.projectOpen, () => {
            projectOpens.push('www.overleaf.com:project');
            return {projectKey:'www.overleaf.com:project', shared:false};
        });
        rpc.onRequest(RPC_METHOD.replicaAttach, async () => {
            attached.push('replica');
            const replicaId = `replica-${attached.length}`;
            if (holdAttach || interruptRestore) {
                if (interruptRestore) { interruptRestore = false; socket.destroy(); }
                await new Promise<void>(resolve => socket.once('close', () => resolve()));
            }
            return {
                replicaId, root:'/project', serverName:'www.overleaf.com',
                projectId:'project', projectName:'Test', shared:false,
                status:{state:'active'}, conflicts:[],
            } satisfies ReplicaAttachResult;
        });
        rpc.onRequest(RPC_METHOD.replicaRetry, (params:{replicaId:string}) => { retryIds.push(params.replicaId); return null; });
        rpc.onRequest(RPC_METHOD.projectCall, async () => {
            mutations++;
            socket.destroy();
            await new Promise(resolve => setTimeout(resolve, 0));
            return null;
        });
        rpc.onRequest(RPC_METHOD.daemonStatus, () => ({pid:process.pid, projects:projectOpens.length}));
        rpc.listen();
        socket.on('close', () => rpc.dispose());
    });
    await new Promise<void>(resolve => server.listen(paths.socketPath, resolve));
    await writeFile(paths.metadataPath, JSON.stringify({
        pid:process.pid, socketPath:paths.socketPath, token:randomUUID(), protocolVersion:1,
    }));
    cleanup.push(async () => {
        for (const socket of sockets) { socket.destroy(); }
        await new Promise<void>(resolve => server.close(() => resolve()));
        await rm(home, {recursive:true, force:true});
    });
    const client = await LeafRelayDaemonClient.connect({clientName:'test', clientVersion:'test', environment, autoStart:false});
    cleanup.push(async () => client.close());
    return {
        client, attached, projectOpens, retryIds,
        hold:() => { holdAttach = true; },
        disconnect:() => { holdAttach = false; sockets.at(-1)!.destroy(); },
        interruptRestore:() => { interruptRestore = true; },
        mutations:() => mutations,
    };
}

describe('daemon client registration recovery', () => {
    it('restores a replica interrupted during its initial reconciliation', async () => {
        const peer = await daemonPeer();
        await peer.client.openProject('www.overleaf.com', 'project');
        peer.hold();
        const attaching = peer.client.attachReplica({directory:'/project'});
        await vi.waitFor(() => expect(peer.attached).toHaveLength(1));
        peer.disconnect();
        const attached = await attaching;
        expect(attached.status.state).toBe('active');
        expect(peer.attached).toHaveLength(2);
        expect(peer.projectOpens).toHaveLength(2);
        await peer.client.retry(attached.replicaId, '/main.tex');
        expect(peer.retryIds).toEqual(['replica-2']);
    });

    it('retries a connection lost while restoring registrations and preserves the public replica ID', async () => {
        const peer = await daemonPeer();
        const replica = await peer.client.attachReplica({directory:'/project'});
        const statuses:string[] = [];
        peer.client.onReplicaStatus(event => statuses.push(event.replicaId));
        peer.interruptRestore();
        peer.disconnect();
        await vi.waitFor(() => expect(peer.attached).toHaveLength(3), {timeout:4000});
        await peer.client.retry(replica.replicaId, '/main.tex');
        expect(peer.retryIds).toEqual(['replica-3']);
        expect(statuses).toContain(replica.replicaId);
    });

    it('does not replay a mutation whose reply was lost', async () => {
        const peer = await daemonPeer();
        const project = await peer.client.openProject('www.overleaf.com', 'project');
        await expect(peer.client.callProject(project.projectKey, 'applyOtUpdate', [])).rejects.toThrow();
        await vi.waitFor(() => expect(peer.projectOpens).toHaveLength(2));
        await peer.client.status();
        expect(peer.mutations()).toBe(1);
    });
});
