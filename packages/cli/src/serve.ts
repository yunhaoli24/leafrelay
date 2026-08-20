import {LeafRelayDaemonClient} from '@leafrelay/daemon';
import type {ReplicaAttachResult, ReplicaConflictNotification, ReplicaStatusNotification} from '@leafrelay/protocol';
import {connectCliDaemon} from './daemonClient';

export interface RunningServe {
    readonly replica:ReplicaAttachResult;
    stop():Promise<void>;
}

export async function startServe(directory=process.cwd()):Promise<RunningServe> {
    const client = await connectCliDaemon();
    client.onLog(event => console.log(`${event.timestamp} [${event.level}] ${event.message}`));
    client.onReplicaStatus((event:ReplicaStatusNotification) => {
        console.log(`Replica ${event.replicaId}: ${event.status.state}${event.status.message ? ` (${event.status.message})` : ''}`);
    });
    client.onReplicaConflict((event:ReplicaConflictNotification) => {
        console.error(`Conflict in ${event.path}: ${event.reason}`);
    });
    try {
        const replica = await client.attachReplica({directory});
        return {
            replica,
            stop:async () => {
                await client.detachReplica(replica.replicaId);
                client.close();
            },
        };
    } catch (error) {
        client.close();
        throw error;
    }
}

export async function serve(directory=process.cwd()):Promise<void> {
    const running = await startServe(directory);
    console.log(`${running.replica.shared ? 'Attached to' : 'Started'} ${running.replica.projectName} at ${running.replica.root}.`);
    await new Promise<void>((resolveStop) => {
        const stop = () => {
            process.off('SIGINT', stop);
            process.off('SIGTERM', stop);
            running.stop().then(resolveStop, error => {
                console.error(error);
                resolveStop();
            });
        };
        process.on('SIGINT', stop);
        process.on('SIGTERM', stop);
    });
}

export async function daemonStatus():Promise<void> {
    let client:LeafRelayDaemonClient|undefined;
    try {
        client = await connectCliDaemon(false);
        console.log(JSON.stringify(await client.status(), null, 2));
    } catch {
        console.log('LeafRelay daemon is not running.');
    } finally {
        client?.close();
    }
}

export async function daemonStop():Promise<void> {
    let client:LeafRelayDaemonClient|undefined;
    try {
        client = await connectCliDaemon(false);
        await client.shutdownDaemon();
        console.log('LeafRelay daemon stopped.');
    } catch {
        console.log('LeafRelay daemon is not running.');
    } finally {
        client?.close();
    }
}

export async function daemonRestart():Promise<void> {
    await daemonStop();
    const client = await connectCliDaemon();
    const status = await client.status();
    console.log(`LeafRelay daemon restarted (pid ${status.pid}).`);
    client.close();
}
