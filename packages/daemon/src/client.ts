import {randomUUID} from 'node:crypto';
import {mkdir, readFile, rm, stat} from 'node:fs/promises';
import {connect, type Socket} from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {
    LEAFRELAY_PROTOCOL_VERSION,
    RPC_METHOD,
    RPC_NOTIFICATION,
    type DaemonMetadata,
    type DaemonStatus,
    type InitializeParams,
    type InitializeResult,
    type LogNotification,
    type ReplicaAttachParams,
    type ReplicaAttachResult,
    type ReplicaConflictNotification,
    type ReplicaConflictResolutionParams,
    type ReplicaStatusNotification,
} from '@leafrelay/protocol';
import {createMessageConnection, type MessageConnection} from 'vscode-jsonrpc/node';
import {daemonPaths, type DaemonPaths} from './paths';

const START_TIMEOUT_MS = 15_000;
const START_POLL_MS = 75;

export interface DaemonClientOptions {
    clientName:InitializeParams['clientName'];
    clientVersion:string;
    clientId?:string;
    daemonEntrypoint?:string|URL;
    environment?:NodeJS.ProcessEnv;
    autoStart?:boolean;
}

export class LeafRelayDaemonClient {
    private constructor(
        private readonly socket:Socket,
        private readonly rpc:MessageConnection,
        readonly initializeResult:InitializeResult,
        readonly clientId:string,
    ) {}

    static async connect(options:DaemonClientOptions):Promise<LeafRelayDaemonClient> {
        const environment = options.environment ?? process.env;
        const paths = daemonPaths(environment);
        let metadata = await readMetadata(paths);
        let connected = metadata ? await tryConnect(metadata) : undefined;
        if (!connected && options.autoStart!==false) {
            metadata = await startDaemon(paths, options, environment);
            connected = await tryConnect(metadata);
        }
        if (!metadata || !connected) {
            throw new Error(`LeafRelay daemon is not running at ${paths.socketPath}.`);
        }
        const rpc = createMessageConnection(connected, connected);
        rpc.listen();
        const clientId = options.clientId ?? randomUUID();
        try {
            const initializeResult = await rpc.sendRequest<InitializeResult>(RPC_METHOD.initialize, {
                token:metadata.token,
                clientId,
                clientName:options.clientName,
                clientVersion:options.clientVersion,
                protocolVersion:LEAFRELAY_PROTOCOL_VERSION,
            } satisfies InitializeParams);
            return new LeafRelayDaemonClient(connected, rpc, initializeResult, clientId);
        } catch (error) {
            rpc.dispose();
            connected.destroy();
            throw error;
        }
    }

    status():Promise<DaemonStatus> {
        return this.rpc.sendRequest(RPC_METHOD.daemonStatus);
    }

    attachReplica(params:ReplicaAttachParams):Promise<ReplicaAttachResult> {
        return this.rpc.sendRequest(RPC_METHOD.replicaAttach, params);
    }

    async detachReplica(replicaId:string):Promise<void> {
        await this.rpc.sendRequest(RPC_METHOD.replicaDetach, {replicaId});
    }

    async resolveConflict(params:ReplicaConflictResolutionParams):Promise<void> {
        await this.rpc.sendRequest(RPC_METHOD.replicaResolveConflict, params);
    }

    async retry(replicaId:string, path:string):Promise<void> {
        await this.rpc.sendRequest(RPC_METHOD.replicaRetry, {replicaId, path});
    }

    onLog(handler:(event:LogNotification) => void):void {
        this.rpc.onNotification(RPC_NOTIFICATION.log, handler);
    }

    onReplicaStatus(handler:(event:ReplicaStatusNotification) => void):void {
        this.rpc.onNotification(RPC_NOTIFICATION.replicaStatus, handler);
    }

    onReplicaConflict(handler:(event:ReplicaConflictNotification) => void):void {
        this.rpc.onNotification(RPC_NOTIFICATION.replicaConflict, handler);
    }

    async shutdownDaemon():Promise<void> {
        await this.rpc.sendRequest(RPC_METHOD.daemonShutdown);
    }

    close():void {
        this.rpc.dispose();
        this.socket.destroy();
    }
}

async function startDaemon(paths:DaemonPaths, options:DaemonClientOptions, environment:NodeJS.ProcessEnv):Promise<DaemonMetadata> {
    await mkdir(paths.home, {recursive:true, mode:0o700});
    let ownsLock = false;
    try {
        await mkdir(paths.startupLockPath, {mode:0o700});
        ownsLock = true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code!=='EEXIST') { throw error; }
        const lockStat = await stat(paths.startupLockPath).catch(() => undefined);
        if (lockStat && Date.now()-lockStat.mtimeMs>START_TIMEOUT_MS) {
            await rm(paths.startupLockPath, {recursive:true, force:true});
            return startDaemon(paths, options, environment);
        }
    }

    if (ownsLock) {
        try {
            const entrypoint = options.daemonEntrypoint ?? new URL('./daemon.js', import.meta.url);
            const childEnvironment = {...environment};
            childEnvironment.LEAFRELAY_HOME = paths.home;
            const child = spawn(process.execPath, [typeof entrypoint==='string' ? entrypoint : fileURLToPath(entrypoint)], {
                detached:true,
                stdio:'ignore',
                env:childEnvironment,
            });
            child.unref();
            return await waitForDaemon(paths);
        } finally {
            await rm(paths.startupLockPath, {recursive:true, force:true});
        }
    }
    return waitForDaemon(paths);
}

async function waitForDaemon(paths:DaemonPaths):Promise<DaemonMetadata> {
    const deadline = Date.now()+START_TIMEOUT_MS;
    let lastError:unknown;
    while (Date.now()<deadline) {
        try {
            const metadata = await readMetadata(paths);
            if (metadata && await tryConnect(metadata).then(socket => {
                socket?.destroy();
                return Boolean(socket);
            })) { return metadata; }
        } catch (error) {
            lastError = error;
        }
        await new Promise(resolveWait => setTimeout(resolveWait, START_POLL_MS));
    }
    throw new Error(`LeafRelay daemon did not start within ${START_TIMEOUT_MS}ms.`, {cause:lastError});
}

async function readMetadata(paths:DaemonPaths):Promise<DaemonMetadata|undefined> {
    try {
        return JSON.parse(await readFile(paths.metadataPath, 'utf8')) as DaemonMetadata;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code==='ENOENT') { return undefined; }
        throw error;
    }
}

async function tryConnect(metadata:DaemonMetadata):Promise<Socket|undefined> {
    return new Promise(resolveConnection => {
        const socket = connect(metadata.socketPath);
        socket.once('connect', () => resolveConnection(socket));
        socket.once('error', () => {
            socket.destroy();
            resolveConnection(undefined);
        });
    });
}
