import {randomBytes} from 'node:crypto';
import {appendFile, chmod, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {createServer, type Server, type Socket} from 'node:net';
import {
    readProjectSettings,
    startServe,
} from '@leafrelay/core';
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
    type ReplicaConflictResolutionParams,
    type ReplicaStatusNotification,
    type ReplicaConflictNotification,
    type ProjectCallParams,
    type ProjectEventNotification,
    type ProjectOpenParams,
    type ServerCallParams,
    type ServerImportParams,
    type ServerLoginParams,
} from '@leafrelay/protocol';
import {createMessageConnection, ResponseError, type MessageConnection} from 'vscode-jsonrpc/node';
import {daemonPaths, type DaemonPaths} from './paths';
import {decodeRpcValue, encodeRpcValue} from './codec';
import {NetworkRuntimeRegistry} from './networkRuntime';
import {ReplicaAlreadyActiveError, ReplicaRegistry} from './replicaRegistry';

declare const LEAFRELAY_DAEMON_VERSION:string;

const IDLE_EXIT_MS = 60_000;
const REPLICA_ALREADY_ACTIVE = -32010;
const daemonVersion = typeof LEAFRELAY_DAEMON_VERSION==='string' ? LEAFRELAY_DAEMON_VERSION : 'development';

interface ClientConnection {
    socket:Socket;
    rpc:MessageConnection;
    clientId?:string;
    initialized:boolean;
}

export interface DaemonServerOptions {
    paths?:DaemonPaths;
    token?:string;
    exitOnIdle?:boolean;
}

export class LeafRelayDaemonServer {
    private readonly paths:DaemonPaths;
    private readonly token:string;
    private readonly startedAt = new Date().toISOString();
    private readonly clients = new Set<ClientConnection>();
    private readonly network:NetworkRuntimeRegistry;
    private readonly replicas:ReplicaRegistry;
    private server?:Server;
    private idleTimer?:NodeJS.Timeout;
    private stopping?:Promise<void>;

    constructor(private readonly options:DaemonServerOptions={}) {
        this.paths = options.paths ?? daemonPaths();
        this.token = options.token ?? randomBytes(32).toString('hex');
        this.network = new NetworkRuntimeRegistry({
            projectEvent:(owners, notification) => this.notifyOwners(owners, RPC_NOTIFICATION.projectEvent, notification),
            log:(level, message) => void this.log(level, message),
        });
        this.replicas = new ReplicaRegistry({
            status:(owners, notification) => this.notifyOwners(owners, RPC_NOTIFICATION.replicaStatus, notification),
            conflict:(owners, notification) => this.notifyOwners(owners, RPC_NOTIFICATION.replicaConflict, notification),
            empty:() => this.scheduleIdleExit(),
            log:message => void this.log('info', message),
        }, async (directory, startOptions) => {
            const settings = await readProjectSettings(directory);
            const lease = await this.network.acquireReplica(settings.serverName, settings.projectId);
            try {
                const running = await startServe(directory, {...startOptions, remote:lease.remote});
                return {
                    ...running,
                    stop:async () => {
                        await running.stop();
                        lease.release();
                    },
                };
            } catch (error) {
                lease.release();
                throw error;
            }
        });
    }

    async start():Promise<DaemonMetadata> {
        await mkdir(this.paths.home, {recursive:true, mode:0o700});
        if (process.platform!=='win32') { await rm(this.paths.socketPath, {force:true}); }
        this.server = createServer(socket => this.accept(socket));
        await new Promise<void>((resolveListen, reject) => {
            this.server!.once('error', reject);
            this.server!.listen(this.paths.socketPath, () => {
                this.server!.off('error', reject);
                resolveListen();
            });
        });
        if (process.platform!=='win32') { await chmod(this.paths.socketPath, 0o600); }
        const metadata:DaemonMetadata = {
            pid:process.pid,
            socketPath:this.paths.socketPath,
            token:this.token,
            protocolVersion:LEAFRELAY_PROTOCOL_VERSION,
            version:daemonVersion,
            startedAt:this.startedAt,
        };
        await writeFile(this.paths.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, {encoding:'utf8', mode:0o600});
        await chmod(this.paths.metadataPath, 0o600);
        await this.log('info', `Daemon ${daemonVersion} listening on ${this.paths.socketPath}.`);
        this.scheduleIdleExit();
        return metadata;
    }

    async stop():Promise<void> {
        if (this.stopping) { return this.stopping; }
        this.stopping = this.performStop();
        return this.stopping;
    }

    status():DaemonStatus {
        return {
            pid:process.pid,
            version:daemonVersion,
            protocolVersion:LEAFRELAY_PROTOCOL_VERSION,
            startedAt:this.startedAt,
            clients:this.clients.size,
            projects:this.network.projectCount,
            replicas:this.replicas.list(),
        };
    }

    private accept(socket:Socket):void {
        this.cancelIdleExit();
        const rpc = createMessageConnection(socket, socket);
        const client:ClientConnection = {socket, rpc, initialized:false};
        this.clients.add(client);
        rpc.onRequest(RPC_METHOD.initialize, (params:InitializeParams) => this.initialize(client, params));
        rpc.onRequest(RPC_METHOD.daemonStatus, () => this.authorized(client, () => this.status()));
        rpc.onRequest(RPC_METHOD.daemonShutdown, () => this.authorized(client, async () => {
            setTimeout(() => void this.stop(), 25);
            return null;
        }));
        rpc.onRequest(RPC_METHOD.replicaAttach, (params:ReplicaAttachParams) => this.authorized(client, async () => {
            try {
                return await this.replicas.attach(client.clientId!, params);
            } catch (error) {
                if (error instanceof ReplicaAlreadyActiveError) {
                    throw new ResponseError(REPLICA_ALREADY_ACTIVE, error.message, {
                        code:error.code,
                        projectId:error.projectId,
                        activeRoot:error.activeRoot,
                        requestedRoot:error.requestedRoot,
                    });
                }
                throw error;
            }
        }));
        rpc.onRequest(RPC_METHOD.replicaDetach, (params:{replicaId:string}) => this.authorized(client, () => {
            this.replicas.detach(client.clientId!, params.replicaId);
            return null;
        }));
        rpc.onRequest(RPC_METHOD.replicaResolveConflict, (params:ReplicaConflictResolutionParams) => this.authorized(client, async () => {
            await this.replicas.resolveConflict(params.replicaId, params.path, params.winner);
            return null;
        }));
        rpc.onRequest(RPC_METHOD.replicaRetry, (params:{replicaId:string; path:string}) => this.authorized(client, async () => {
            await this.replicas.retry(params.replicaId, params.path);
            return null;
        }));
        rpc.onRequest(RPC_METHOD.serverList, () => this.authorized(client, () => this.network.listServers()));
        rpc.onRequest(RPC_METHOD.serverAdd, (params:{name:string; url:string}) => this.authorized(client, async () => {
            await this.network.addServer(params.name, params.url);
            return null;
        }));
        rpc.onRequest(RPC_METHOD.serverRemove, (params:{server:string}) => this.authorized(client, async () => {
            await this.network.removeServer(params.server);
            return null;
        }));
        rpc.onRequest(RPC_METHOD.sessionLogin, (params:ServerLoginParams) => this.authorized(client, () => this.network.login(params)));
        rpc.onRequest(RPC_METHOD.sessionImport, (params:ServerImportParams) => this.authorized(client, () => this.network.importSession(params)));
        rpc.onRequest(RPC_METHOD.sessionLogout, (params:{server:string}) => this.authorized(client, async () => {
            await this.network.logout(params.server);
            return null;
        }));
        rpc.onRequest(RPC_METHOD.serverCall, (params:ServerCallParams) => this.authorized(client, async () => {
            const result = await this.network.callServer(params.server, params.operation, decodeRpcValue(params.args) as unknown[]);
            return encodeRpcValue(result);
        }));
        rpc.onRequest(RPC_METHOD.projectOpen, (params:ProjectOpenParams) => this.authorized(client, () => (
            this.network.openProject(client.clientId!, params.server, params.projectId)
        )));
        rpc.onRequest(RPC_METHOD.projectClose, (params:{projectKey:string}) => this.authorized(client, () => {
            this.network.closeProject(client.clientId!, params.projectKey);
            return null;
        }));
        rpc.onRequest(RPC_METHOD.projectCall, (params:ProjectCallParams) => this.authorized(client, async () => {
            const result = await this.network.callProject(params.projectKey, params.operation, decodeRpcValue(params.args) as unknown[]);
            return encodeRpcValue(await result);
        }));
        rpc.onClose(() => this.closeClient(client));
        rpc.onError(error => void this.log('error', `JSON-RPC connection error: ${String(error[0])}`));
        rpc.listen();
    }

    private initialize(client:ClientConnection, params:InitializeParams):InitializeResult {
        if (params.token!==this.token) { throw new ResponseError(-32001, 'Daemon authentication failed.'); }
        if (params.protocolVersion!==LEAFRELAY_PROTOCOL_VERSION) {
            throw new ResponseError(-32002, `Protocol ${params.protocolVersion} is incompatible with daemon protocol ${LEAFRELAY_PROTOCOL_VERSION}.`);
        }
        if (!params.clientId) { throw new ResponseError(-32602, 'clientId is required.'); }
        client.clientId = params.clientId;
        client.initialized = true;
        void this.log('info', `${params.clientName} ${params.clientVersion} connected (${params.clientId}).`);
        return {
            daemonVersion:daemonVersion,
            protocolVersion:LEAFRELAY_PROTOCOL_VERSION,
            pid:process.pid,
            startedAt:this.startedAt,
        };
    }

    private async authorized<T>(client:ClientConnection, operation:() => T|Promise<T>):Promise<T> {
        if (!client.initialized) { throw new ResponseError(-32001, 'Initialize the daemon connection first.'); }
        return operation();
    }

    private closeClient(client:ClientConnection):void {
        if (!this.clients.delete(client)) { return; }
        if (client.clientId) { this.replicas.detachClient(client.clientId); }
        if (client.clientId) { this.network.detachClient(client.clientId); }
        this.scheduleIdleExit();
    }

    private notifyOwners(
        owners:ReadonlySet<string>,
        method:typeof RPC_NOTIFICATION.replicaStatus|typeof RPC_NOTIFICATION.replicaConflict|typeof RPC_NOTIFICATION.projectEvent,
        notification:ReplicaStatusNotification|ReplicaConflictNotification|ProjectEventNotification,
    ):void {
        for (const client of this.clients) {
            if (client.clientId && owners.has(client.clientId)) { void client.rpc.sendNotification(method, notification); }
        }
    }

    private async log(level:LogNotification['level'], message:string):Promise<void> {
        const notification:LogNotification = {timestamp:new Date().toISOString(), level, message};
        await appendFile(this.paths.logPath, `${notification.timestamp} [${level}] ${message}\n`, {encoding:'utf8', mode:0o600});
        for (const client of this.clients) {
            if (client.initialized) { void client.rpc.sendNotification(RPC_NOTIFICATION.log, notification); }
        }
    }

    private scheduleIdleExit():void {
        if (this.options.exitOnIdle===false || this.clients.size!==0 || this.replicas.size!==0 || this.idleTimer) { return; }
        this.idleTimer = setTimeout(() => void this.stop(), IDLE_EXIT_MS);
        this.idleTimer.unref();
    }

    private cancelIdleExit():void {
        if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = undefined; }
    }

    private async performStop():Promise<void> {
        this.cancelIdleExit();
        await this.replicas.stopAll();
        await this.network.stopAll();
        for (const client of this.clients) {
            client.rpc.dispose();
            client.socket.destroy();
        }
        this.clients.clear();
        if (this.server) {
            await new Promise<void>(resolveClose => this.server!.close(() => resolveClose()));
        }
        await rm(this.paths.metadataPath, {force:true});
        if (process.platform!=='win32') { await rm(this.paths.socketPath, {force:true}); }
    }
}

export async function readDaemonMetadata(paths:DaemonPaths=daemonPaths()):Promise<DaemonMetadata|undefined> {
    try {
        return JSON.parse(await readFile(paths.metadataPath, 'utf8')) as DaemonMetadata;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code==='ENOENT') { return undefined; }
        throw error;
    }
}
