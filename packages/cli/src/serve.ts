import {LeafRelayDaemonClient, type DaemonClientOptions} from '@leafrelay/daemon';
import type {ReplicaAttachResult, ReplicaConflictNotification, ReplicaStatusNotification} from '@leafrelay/protocol';

declare const LEAFRELAY_VERSION:string;

export interface RunningServe {
    readonly replica:ReplicaAttachResult;
    stop():Promise<void>;
}

function clientOptions(autoStart=true):DaemonClientOptions {
    return {
        clientName:'cli',
        clientVersion:LEAFRELAY_VERSION,
        daemonEntrypoint:new URL('./daemon.js', import.meta.url),
        autoStart,
    };
}

export async function startServe(directory=process.cwd()):Promise<RunningServe> {
    const client = await LeafRelayDaemonClient.connect(clientOptions());
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
        client = await LeafRelayDaemonClient.connect(clientOptions(false));
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
        client = await LeafRelayDaemonClient.connect(clientOptions(false));
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
    const client = await LeafRelayDaemonClient.connect(clientOptions());
    const status = await client.status();
    console.log(`LeafRelay daemon restarted (pid ${status.pid}).`);
    client.close();
}
