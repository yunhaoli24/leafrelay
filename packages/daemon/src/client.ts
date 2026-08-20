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
    type ProjectEventNotification,
    type ProjectOpenResult,
    type ReplicaAttachParams,
    type ReplicaAttachResult,
    type ReplicaConflictNotification,
    type ReplicaConflictResolutionParams,
    type ReplicaStatusNotification,
    type ServerDescriptor,
    type ServerImportParams,
    type ServerLoginParams,
} from '@leafrelay/protocol';
import type {MessageConnection} from 'vscode-jsonrpc/node';
import {decodeRpcValue, encodeRpcValue} from './codec';
import {daemonPaths, type DaemonPaths} from './paths';
import {createSocketRpcConnection} from './transport';

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

export interface DaemonClientListener {
    dispose():void;
}

interface ReplicaRegistration {
    params:ReplicaAttachParams;
    currentId:string;
}

interface ProjectRegistration {
    server:string;
    projectId:string;
    currentKey:string;
}

export class LeafRelayDaemonClient {
    private socket?:Socket;
    private rpc?:MessageConnection;
    private connected = false;
    private closing = false;
    private reconnecting?:Promise<void>;
    private connectionClosed:Promise<void> = Promise.resolve();
    private initializeState!:InitializeResult;
    private readonly paths:DaemonPaths;
    private readonly environment:NodeJS.ProcessEnv;
    private readonly logListeners = new Set<(event:LogNotification) => void>();
    private readonly statusListeners = new Set<(event:ReplicaStatusNotification) => void>();
    private readonly conflictListeners = new Set<(event:ReplicaConflictNotification) => void>();
    private readonly projectListeners = new Set<(event:ProjectEventNotification) => void>();
    private readonly replicas = new Map<string,ReplicaRegistration>();
    private readonly projects = new Map<string,ProjectRegistration>();

    readonly clientId:string;

    private constructor(private readonly options:DaemonClientOptions) {
        this.environment = options.environment ?? process.env;
        this.paths = daemonPaths(this.environment);
        this.clientId = options.clientId ?? randomUUID();
    }

    static async connect(options:DaemonClientOptions):Promise<LeafRelayDaemonClient> {
        const client = new LeafRelayDaemonClient(options);
        await client.connectTransport();
        return client;
    }

    get initializeResult():InitializeResult { return this.initializeState; }

    status():Promise<DaemonStatus> {
        return this.request(RPC_METHOD.daemonStatus);
    }

    async attachReplica(params:ReplicaAttachParams):Promise<ReplicaAttachResult> {
        const result = await this.request<ReplicaAttachResult>(RPC_METHOD.replicaAttach, params);
        this.replicas.set(result.replicaId, {params, currentId:result.replicaId});
        return result;
    }

    async detachReplica(replicaId:string):Promise<void> {
        const registration = this.replicas.get(replicaId);
        await this.request(RPC_METHOD.replicaDetach, {replicaId:registration?.currentId ?? replicaId});
        this.replicas.delete(replicaId);
    }

    async resolveConflict(params:ReplicaConflictResolutionParams):Promise<void> {
        const registration = this.replicas.get(params.replicaId);
        await this.request(RPC_METHOD.replicaResolveConflict, {
            ...params,
            replicaId:registration?.currentId ?? params.replicaId,
        });
    }

    async retry(replicaId:string, path:string):Promise<void> {
        const registration = this.replicas.get(replicaId);
        await this.request(RPC_METHOD.replicaRetry, {replicaId:registration?.currentId ?? replicaId, path});
    }

    onLog(handler:(event:LogNotification) => void):DaemonClientListener {
        return addListener(this.logListeners, handler);
    }

    onReplicaStatus(handler:(event:ReplicaStatusNotification) => void):DaemonClientListener {
        return addListener(this.statusListeners, handler);
    }

    onReplicaConflict(handler:(event:ReplicaConflictNotification) => void):DaemonClientListener {
        return addListener(this.conflictListeners, handler);
    }

    listServers():Promise<ServerDescriptor[]> {
        return this.request(RPC_METHOD.serverList);
    }

    async addServer(name:string, url:string):Promise<void> {
        await this.request(RPC_METHOD.serverAdd, {name, url});
    }

    async removeServer(server:string):Promise<void> {
        await this.request(RPC_METHOD.serverRemove, {server});
    }

    login(params:ServerLoginParams):Promise<{userId:string; userEmail:string}> {
        return this.request(RPC_METHOD.sessionLogin, params);
    }

    importSession(params:ServerImportParams):Promise<{userId:string; userEmail:string}> {
        return this.request(RPC_METHOD.sessionImport, params);
    }

    async logout(server:string):Promise<void> {
        await this.request(RPC_METHOD.sessionLogout, {server});
    }

    async callServer<T=unknown>(server:string, operation:string, args:unknown[]=[]):Promise<T> {
        const result = await this.request(RPC_METHOD.serverCall, {server, operation, args:encodeRpcValue(args)});
        return decodeRpcValue(result) as T;
    }

    async openProject(server:string, projectId:string):Promise<ProjectOpenResult> {
        const result = await this.request<ProjectOpenResult>(RPC_METHOD.projectOpen, {server, projectId});
        this.projects.set(result.projectKey, {server, projectId, currentKey:result.projectKey});
        return result;
    }

    async closeProject(projectKey:string):Promise<void> {
        const registration = this.projects.get(projectKey);
        await this.request(RPC_METHOD.projectClose, {projectKey:registration?.currentKey ?? projectKey});
        this.projects.delete(projectKey);
    }

    async callProject<T=unknown>(projectKey:string, operation:string, args:unknown[]=[]):Promise<T> {
        const registration = this.projects.get(projectKey);
        const result = await this.request(RPC_METHOD.projectCall, {
            projectKey:registration?.currentKey ?? projectKey,
            operation,
            args:encodeRpcValue(args),
        });
        return decodeRpcValue(result) as T;
    }

    onProjectEvent(handler:(event:ProjectEventNotification) => void):DaemonClientListener {
        return addListener(this.projectListeners, handler);
    }

    async shutdownDaemon():Promise<void> {
        this.closing = true;
        await this.rawRequest(RPC_METHOD.daemonShutdown);
    }

    close():void {
        this.closing = true;
        this.connected = false;
        this.rpc?.dispose();
        this.socket?.destroy();
        this.rpc = undefined;
        this.socket = undefined;
    }

    private async request<T>(method:string, params?:unknown):Promise<T> {
        if (!this.connected) { await this.ensureReconnected(); }
        try {
            return await this.rawRequest<T>(method, params);
        } catch (requestError) {
            if (this.connected || this.closing) { throw requestError; }
            await this.ensureReconnected();
            return this.rawRequest<T>(method, params);
        }
    }

    private rawRequest<T>(method:string, params?:unknown):Promise<T> {
        if (!this.rpc) { return Promise.reject(new Error('LeafRelay daemon is disconnected.')); }
        const response = params===undefined ? this.rpc.sendRequest<T>(method) : this.rpc.sendRequest<T>(method, params);
        return Promise.race([
            response,
            this.connectionClosed.then(() => Promise.reject(new Error('LeafRelay daemon connection closed.'))),
        ]);
    }

    private async ensureReconnected():Promise<void> {
        if (this.closing) { throw new Error('LeafRelay daemon client is closed.'); }
        this.reconnecting ??= this.connectTransport().finally(() => { this.reconnecting = undefined; });
        return this.reconnecting;
    }

    private async connectTransport():Promise<void> {
        const metadata = await this.findOrStartDaemon();
        const socket = await tryConnect(metadata);
        if (!socket) { throw new Error(`LeafRelay daemon is not running at ${this.paths.socketPath}.`); }
        const rpc = createSocketRpcConnection(socket);
        let signalClosed!:() => void;
        this.connectionClosed = new Promise(resolveClosed => { signalClosed = resolveClosed; });
        this.socket = socket;
        this.rpc = rpc;
        this.registerNotifications(rpc);
        rpc.onClose(() => {
            signalClosed();
            if (this.rpc!==rpc) { return; }
            this.connected = false;
            this.rpc = undefined;
            this.socket = undefined;
            if (!this.closing) { void this.ensureReconnected(); }
        });
        rpc.listen();
        try {
            this.initializeState = await rpc.sendRequest<InitializeResult>(RPC_METHOD.initialize, {
                token:metadata.token,
                clientId:this.clientId,
                clientName:this.options.clientName,
                clientVersion:this.options.clientVersion,
                protocolVersion:LEAFRELAY_PROTOCOL_VERSION,
            } satisfies InitializeParams);
            this.connected = true;
            await this.restoreRegistrations(rpc);
        } catch (connectError) {
            rpc.dispose();
            socket.destroy();
            if (this.rpc===rpc) { this.rpc = undefined; this.socket = undefined; }
            throw connectError;
        }
    }

    private async restoreRegistrations(rpc:MessageConnection):Promise<void> {
        for (const registration of this.projects.values()) {
            const result = await rpc.sendRequest<ProjectOpenResult>(RPC_METHOD.projectOpen, {
                server:registration.server,
                projectId:registration.projectId,
            });
            registration.currentKey = result.projectKey;
        }
        for (const registration of this.replicas.values()) {
            const result = await rpc.sendRequest<ReplicaAttachResult>(RPC_METHOD.replicaAttach, registration.params);
            registration.currentId = result.replicaId;
        }
    }

    private registerNotifications(rpc:MessageConnection):void {
        rpc.onNotification(RPC_NOTIFICATION.log, event => dispatch(this.logListeners, event));
        rpc.onNotification(RPC_NOTIFICATION.replicaStatus, (event:ReplicaStatusNotification) => {
            dispatch(this.statusListeners, {...event, replicaId:this.stableReplicaId(event.replicaId)});
        });
        rpc.onNotification(RPC_NOTIFICATION.replicaConflict, (event:ReplicaConflictNotification) => {
            dispatch(this.conflictListeners, {...event, replicaId:this.stableReplicaId(event.replicaId)});
        });
        rpc.onNotification(RPC_NOTIFICATION.projectEvent, (event:ProjectEventNotification) => {
            dispatch(this.projectListeners, {...event, projectKey:this.stableProjectKey(event.projectKey)});
        });
    }

    private stableReplicaId(currentId:string):string {
        return [...this.replicas].find(([, registration]) => registration.currentId===currentId)?.[0] ?? currentId;
    }

    private stableProjectKey(currentKey:string):string {
        return [...this.projects].find(([, registration]) => registration.currentKey===currentKey)?.[0] ?? currentKey;
    }

    private async findOrStartDaemon():Promise<DaemonMetadata> {
        let metadata = await readMetadata(this.paths);
        if (metadata && await tryConnect(metadata).then(socket => {
            socket?.destroy();
            return Boolean(socket);
        })) { return metadata; }
        if (this.options.autoStart===false) {
            throw new Error(`LeafRelay daemon is not running at ${this.paths.socketPath}.`);
        }
        metadata = await startDaemon(this.paths, this.options, this.environment);
        return metadata;
    }
}

function addListener<T>(listeners:Set<(event:T) => void>, handler:(event:T) => void):DaemonClientListener {
    listeners.add(handler);
    return {dispose:() => listeners.delete(handler)};
}

function dispatch<T>(listeners:ReadonlySet<(event:T) => void>, event:T):void {
    for (const listener of listeners) { listener(event); }
}

async function startDaemon(paths:DaemonPaths, options:DaemonClientOptions, environment:NodeJS.ProcessEnv):Promise<DaemonMetadata> {
    await mkdir(paths.home, {recursive:true, mode:0o700});
    let ownsLock = false;
    try {
        await mkdir(paths.startupLockPath, {mode:0o700});
        ownsLock = true;
    } catch (lockError) {
        if ((lockError as NodeJS.ErrnoException).code!=='EEXIST') { throw lockError; }
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
        } catch (pollError) {
            lastError = pollError;
        }
        await new Promise(resolveWait => setTimeout(resolveWait, START_POLL_MS));
    }
    throw new Error(`LeafRelay daemon did not start within ${START_TIMEOUT_MS}ms.`, {cause:lastError});
}

async function readMetadata(paths:DaemonPaths):Promise<DaemonMetadata|undefined> {
    try {
        return JSON.parse(await readFile(paths.metadataPath, 'utf8')) as DaemonMetadata;
    } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code==='ENOENT') { return undefined; }
        throw readError;
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
