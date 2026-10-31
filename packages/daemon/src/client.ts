import { randomUUID } from 'node:crypto';
import { compare, valid } from 'semver';
import { log } from '@leafrelay/core';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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
import type { MessageConnection } from 'vscode-jsonrpc/node';
import { decodeRpcValue, encodeRpcValue } from './codec';
import { daemonPaths, type DaemonPaths } from './paths';
import { createSocketRpcConnection } from './transport';

const START_TIMEOUT_MS = 15_000;
const START_POLL_MS = 75;

export interface DaemonClientOptions {
    clientName: InitializeParams['clientName'];
    clientVersion: string;
    clientId?: string;
    daemonEntrypoint?: string | URL;
    environment?: NodeJS.ProcessEnv;
    autoStart?: boolean;
}

export interface DaemonClientListener {
    dispose(): void;
}

interface ReplicaRegistration {
    params: ReplicaAttachParams;
    currentId?: string;
    result?: ReplicaAttachResult;
}

interface ProjectRegistration {
    server: string;
    projectId: string;
    currentKey: string;
    result?: ProjectOpenResult;
}

export class LeafRelayDaemonClient {
    private socket?: Socket;
    private rpc?: MessageConnection;
    private connected = false;
    private closing = false;
    private reconnecting?: Promise<void>;
    private reconnectTimer?: NodeJS.Timeout;
    private cancelReconnectWait?: () => void;
    private connectionClosed: Promise<void> = Promise.resolve();
    private initializeState!: InitializeResult;
    private readonly paths: DaemonPaths;
    private readonly environment: NodeJS.ProcessEnv;
    private readonly logListeners = new Set<(event: LogNotification) => void>();
    private readonly statusListeners = new Set<(event: ReplicaStatusNotification) => void>();
    private readonly conflictListeners = new Set<(event: ReplicaConflictNotification) => void>();
    private readonly projectListeners = new Set<(event: ProjectEventNotification) => void>();
    private readonly replicas = new Map<string, ReplicaRegistration>();
    private readonly projects = new Map<string, ProjectRegistration>();

    readonly clientId: string;

    private constructor(private readonly options: DaemonClientOptions) {
        this.environment = options.environment ?? process.env;
        this.paths = daemonPaths(this.environment);
        this.clientId = options.clientId ?? randomUUID();
    }

    static async connect(options: DaemonClientOptions): Promise<LeafRelayDaemonClient> {
        const client = new LeafRelayDaemonClient(options);
        client.reconnecting = client.connectTransport();
        try {
            await client.reconnecting;
        } catch (error) {
            client.close();
            throw error;
        } finally {
            client.reconnecting = undefined;
        }
        return client;
    }

    get initializeResult(): InitializeResult {
        return this.initializeState;
    }

    status(): Promise<DaemonStatus> {
        return this.request(RPC_METHOD.daemonStatus);
    }

    async attachReplica(params: ReplicaAttachParams): Promise<ReplicaAttachResult> {
        // Record the directory before startup: a daemon may restart while its
        // initial reconciliation is still running.
        const replicaId = randomUUID();
        const registration: ReplicaRegistration = { params };
        this.replicas.set(replicaId, registration);
        try {
            if (!this.connected) {
                await this.ensureReconnected();
            }
            if (!registration.result) {
                const rpc = this.rpc;
                try {
                    await this.registerReplica(replicaId, registration);
                } catch (error) {
                    if (this.closing || (this.rpc === rpc && this.connected)) {
                        throw error;
                    }
                    await this.ensureReconnected();
                }
            }
            return registration.result!;
        } catch (error) {
            this.replicas.delete(replicaId);
            throw error;
        }
    }

    async detachReplica(replicaId: string): Promise<void> {
        if (!this.connected) {
            await this.ensureReconnected();
        }
        const registration = this.replicas.get(replicaId);
        this.replicas.delete(replicaId);
        await this.request(RPC_METHOD.replicaDetach, { replicaId: registration?.currentId ?? replicaId });
    }

    async resolveConflict(params: ReplicaConflictResolutionParams): Promise<void> {
        if (!this.connected) {
            await this.ensureReconnected();
        }
        const registration = this.replicas.get(params.replicaId);
        await this.request(RPC_METHOD.replicaResolveConflict, {
            ...params,
            replicaId: registration?.currentId ?? params.replicaId,
        });
    }

    async retry(replicaId: string, path: string): Promise<void> {
        if (!this.connected) {
            await this.ensureReconnected();
        }
        const registration = this.replicas.get(replicaId);
        await this.request(RPC_METHOD.replicaRetry, { replicaId: registration?.currentId ?? replicaId, path });
    }

    onLog(handler: (event: LogNotification) => void): DaemonClientListener {
        return addListener(this.logListeners, handler);
    }

    onReplicaStatus(handler: (event: ReplicaStatusNotification) => void): DaemonClientListener {
        return addListener(this.statusListeners, handler);
    }

    onReplicaConflict(handler: (event: ReplicaConflictNotification) => void): DaemonClientListener {
        return addListener(this.conflictListeners, handler);
    }

    listServers(): Promise<ServerDescriptor[]> {
        return this.request(RPC_METHOD.serverList);
    }

    async addServer(name: string, url: string): Promise<void> {
        await this.request(RPC_METHOD.serverAdd, { name, url });
    }

    async removeServer(server: string): Promise<void> {
        await this.request(RPC_METHOD.serverRemove, { server });
    }

    login(params: ServerLoginParams): Promise<{ userId: string; userEmail: string }> {
        return this.request(RPC_METHOD.sessionLogin, params);
    }

    importSession(params: ServerImportParams): Promise<{ userId: string; userEmail: string }> {
        return this.request(RPC_METHOD.sessionImport, params);
    }

    async logout(server: string): Promise<void> {
        await this.request(RPC_METHOD.sessionLogout, { server });
    }

    async callServer<T = unknown>(server: string, operation: string, args: unknown[] = []): Promise<T> {
        const result = await this.request(RPC_METHOD.serverCall, { server, operation, args: encodeRpcValue(args) });
        return decodeRpcValue(result) as T;
    }

    async openProject(server: string, projectId: string): Promise<ProjectOpenResult> {
        const host = new URL(server.includes('://') ? server : `https://${server}`).host;
        const projectKey = `${host}:${projectId}`;
        const registration: ProjectRegistration = { server, projectId, currentKey: projectKey };
        this.projects.set(projectKey, registration);
        try {
            if (!this.connected) {
                await this.ensureReconnected();
            }
            if (!registration.result) {
                const rpc = this.rpc;
                try {
                    await this.registerProject(registration);
                } catch (error) {
                    if (this.closing || (this.rpc === rpc && this.connected)) {
                        throw error;
                    }
                    await this.ensureReconnected();
                }
            }
            return registration.result!;
        } catch (error) {
            if (this.projects.get(projectKey) === registration) {
                this.projects.delete(projectKey);
            }
            throw error;
        }
    }

    async closeProject(projectKey: string): Promise<void> {
        const registration = this.projects.get(projectKey);
        await this.request(RPC_METHOD.projectClose, { projectKey: registration?.currentKey ?? projectKey });
        this.projects.delete(projectKey);
    }

    async callProject<T = unknown>(projectKey: string, operation: string, args: unknown[] = []): Promise<T> {
        const registration = this.projects.get(projectKey);
        const result = await this.request(RPC_METHOD.projectCall, {
            projectKey: registration?.currentKey ?? projectKey,
            operation,
            args: encodeRpcValue(args),
        });
        return decodeRpcValue(result) as T;
    }

    onProjectEvent(handler: (event: ProjectEventNotification) => void): DaemonClientListener {
        return addListener(this.projectListeners, handler);
    }

    async shutdownDaemon(): Promise<void> {
        this.closing = true;
        await this.rawRequest(RPC_METHOD.daemonShutdown);
    }

    close(): void {
        this.closing = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
        }
        this.cancelReconnectWait?.();
        this.connected = false;
        this.rpc?.dispose();
        this.socket?.destroy();
        this.rpc = undefined;
        this.socket = undefined;
    }

    private async request<T>(method: string, params?: unknown): Promise<T> {
        if (!this.connected) {
            await this.ensureReconnected();
        }
        // An interrupted write may already have reached Overleaf. Restore
        // subscriptions on reconnect, but never replay arbitrary mutations.
        return this.rawRequest<T>(method, params);
    }

    private rawRequest<T>(method: string, params?: unknown): Promise<T> {
        if (!this.rpc) {
            return Promise.reject(new Error('LeafRelay daemon is disconnected.'));
        }
        const response =
            params === undefined ? this.rpc.sendRequest<T>(method) : this.rpc.sendRequest<T>(method, params);
        return Promise.race([
            response,
            this.connectionClosed.then(() => Promise.reject(new Error('LeafRelay daemon connection closed.'))),
        ]);
    }

    private async ensureReconnected(): Promise<void> {
        if (this.closing) {
            throw new Error('LeafRelay daemon client is closed.');
        }
        this.reconnecting ??= this.reconnectTransport().finally(() => {
            this.reconnecting = undefined;
        });
        return this.reconnecting;
    }

    private async reconnectTransport(): Promise<void> {
        let attempt = 0;
        while (!this.closing) {
            try {
                await this.connectTransport();
                return;
            } catch (error) {
                // Authentication and protocol failures require user action.
                const code = (error as { code?: number }).code;
                if (code === -32001 || code === -32002 || error instanceof DaemonVersionError || this.closing) {
                    throw error;
                }
                const delay = Math.min(1000 * 2 ** attempt++, 16_000);
                dispatch<LogNotification>(this.logListeners, {
                    timestamp: new Date().toISOString(),
                    level: 'warn',
                    message: `Daemon reconnection failed; retrying in ${delay}ms: ${error instanceof Error ? error.message : String(error)}`,
                });
                await new Promise<void>((resolveWait) => {
                    this.cancelReconnectWait = resolveWait;
                    this.reconnectTimer = setTimeout(resolveWait, delay);
                });
                this.cancelReconnectWait = undefined;
                this.reconnectTimer = undefined;
            }
        }
        throw new Error('LeafRelay daemon client is closed.');
    }

    private async connectTransport(): Promise<void> {
        const metadata = await this.findOrStartDaemon();
        const socket = await tryConnect(metadata);
        if (!socket) {
            throw new Error(`LeafRelay daemon is not running at ${this.paths.socketPath}.`);
        }
        const rpc = createSocketRpcConnection(socket);
        let signalClosed!: () => void;
        this.connectionClosed = new Promise((resolveClosed) => {
            signalClosed = resolveClosed;
        });
        this.socket = socket;
        this.rpc = rpc;
        this.registerNotifications(rpc);
        rpc.onClose(() => {
            signalClosed();
            if (this.rpc !== rpc) {
                return;
            }
            this.connected = false;
            this.rpc = undefined;
            this.socket = undefined;
            for (const registration of this.replicas.values()) {
                registration.currentId = undefined;
                registration.result = undefined;
            }
            for (const registration of this.projects.values()) {
                registration.result = undefined;
            }
            if (!this.closing) {
                void this.ensureReconnected().catch((error) =>
                    dispatch<LogNotification>(this.logListeners, {
                        timestamp: new Date().toISOString(),
                        level: 'error',
                        message: `Daemon reconnection failed: ${error instanceof Error ? error.message : String(error)}`,
                    }),
                );
            }
        });
        rpc.listen();
        try {
            this.initializeState = await rpc.sendRequest<InitializeResult>(RPC_METHOD.initialize, {
                token: metadata.token,
                clientId: this.clientId,
                clientName: this.options.clientName,
                clientVersion: this.options.clientVersion,
                protocolVersion: LEAFRELAY_PROTOCOL_VERSION,
            } satisfies InitializeParams);
            await this.restoreRegistrations();
            this.connected = true;
        } catch (connectError) {
            this.connected = false;
            rpc.dispose();
            socket.destroy();
            if (this.rpc === rpc) {
                this.rpc = undefined;
                this.socket = undefined;
            }
            throw connectError;
        }
    }

    private async restoreRegistrations(): Promise<void> {
        for (const registration of this.projects.values()) {
            await this.registerProject(registration);
        }
        for (const [replicaId, registration] of this.replicas) {
            await this.registerReplica(replicaId, registration);
        }
        if (this.projects.size !== 0 || this.replicas.size !== 0) {
            dispatch<LogNotification>(this.logListeners, {
                timestamp: new Date().toISOString(),
                level: 'info',
                message: `Daemon registrations restored: ${this.projects.size} project(s), ${this.replicas.size} local replica(s).`,
            });
        }
    }

    private async registerProject(registration: ProjectRegistration): Promise<void> {
        const rpc = this.rpc;
        const result = await this.rawRequest<ProjectOpenResult>(RPC_METHOD.projectOpen, {
            server: registration.server,
            projectId: registration.projectId,
        });
        if (this.rpc !== rpc) {
            throw new Error('LeafRelay daemon connection changed during project attachment.');
        }
        registration.currentKey = result.projectKey;
        registration.result = result;
    }

    private async registerReplica(replicaId: string, registration: ReplicaRegistration): Promise<void> {
        const rpc = this.rpc;
        const result = await this.rawRequest<ReplicaAttachResult>(RPC_METHOD.replicaAttach, registration.params);
        if (this.rpc !== rpc) {
            throw new Error('LeafRelay daemon connection changed during replica attachment.');
        }
        registration.currentId = result.replicaId;
        registration.result = { ...result, replicaId };
        dispatch(this.statusListeners, { replicaId, status: result.status });
        for (const path of result.conflicts) {
            dispatch(this.conflictListeners, {
                replicaId,
                path,
                conflicts: result.conflicts,
                reason: 'This path has an unresolved synchronization conflict.',
            });
        }
    }

    private registerNotifications(rpc: MessageConnection): void {
        rpc.onNotification(RPC_NOTIFICATION.log, (event) => dispatch(this.logListeners, event));
        rpc.onNotification(RPC_NOTIFICATION.replicaStatus, (event: ReplicaStatusNotification) => {
            dispatch(this.statusListeners, { ...event, replicaId: this.stableReplicaId(event.replicaId) });
        });
        rpc.onNotification(RPC_NOTIFICATION.replicaConflict, (event: ReplicaConflictNotification) => {
            dispatch(this.conflictListeners, { ...event, replicaId: this.stableReplicaId(event.replicaId) });
        });
        rpc.onNotification(RPC_NOTIFICATION.projectEvent, (event: ProjectEventNotification) => {
            dispatch(this.projectListeners, { ...event, projectKey: this.stableProjectKey(event.projectKey) });
        });
    }

    private stableReplicaId(currentId: string): string {
        return [...this.replicas].find(([, registration]) => registration.currentId === currentId)?.[0] ?? currentId;
    }

    private stableProjectKey(currentKey: string): string {
        return [...this.projects].find(([, registration]) => registration.currentKey === currentKey)?.[0] ?? currentKey;
    }

    private async findOrStartDaemon(): Promise<DaemonMetadata> {
        let metadata = await readMetadata(this.paths);
        if (
            metadata &&
            (await tryConnect(metadata).then((socket) => {
                socket?.destroy();
                return Boolean(socket);
            }))
        ) {
            const order = versionOrder(metadata, this.options);
            if (order > 0) {
                throw newerDaemonError(metadata, this.options);
            }
            if (order === 0 || this.options.autoStart === false) {
                return metadata;
            }
        }
        if (this.options.autoStart === false) {
            throw new Error(`LeafRelay daemon is not running at ${this.paths.socketPath}.`);
        }
        metadata = await startDaemon(this.paths, this.options, this.environment);
        return metadata;
    }
}

function addListener<T>(listeners: Set<(event: T) => void>, handler: (event: T) => void): DaemonClientListener {
    listeners.add(handler);
    return { dispose: () => listeners.delete(handler) };
}

function dispatch<T>(listeners: ReadonlySet<(event: T) => void>, event: T): void {
    for (const listener of listeners) {
        listener(event);
    }
}

async function startDaemon(
    paths: DaemonPaths,
    options: DaemonClientOptions,
    environment: NodeJS.ProcessEnv,
): Promise<DaemonMetadata> {
    await mkdir(paths.home, { recursive: true, mode: 0o700 });
    let ownsLock = false;
    try {
        await mkdir(paths.startupLockPath, { mode: 0o700 });
        ownsLock = true;
    } catch (lockError) {
        if ((lockError as NodeJS.ErrnoException).code !== 'EEXIST') {
            throw lockError;
        }
        const lockStat = await stat(paths.startupLockPath).catch(() => undefined);
        if (lockStat && Date.now() - lockStat.mtimeMs > START_TIMEOUT_MS) {
            await rm(paths.startupLockPath, { recursive: true, force: true });
            return startDaemon(paths, options, environment);
        }
    }

    if (ownsLock) {
        try {
            // Recheck under the shared startup lock: another client may already
            // have replaced the daemon while this client was waiting.
            const running = await readMetadata(paths);
            if (running && (await isListening(running))) {
                const order = versionOrder(running, options);
                if (order > 0) {
                    throw newerDaemonError(running, options);
                }
                if (order === 0) {
                    return running;
                }
                log(
                    `Upgrading LeafRelay daemon ${running.version} to ${options.clientVersion}; waiting for active synchronization to stop.`,
                );
                await stopForUpgrade(paths, running, options);
            }
            const entrypoint = options.daemonEntrypoint ?? new URL('./daemon.js', import.meta.url);
            const childEnvironment = { ...environment };
            childEnvironment.LEAFRELAY_HOME = paths.home;
            const child = spawn(
                process.execPath,
                [typeof entrypoint === 'string' ? entrypoint : fileURLToPath(entrypoint)],
                {
                    detached: true,
                    stdio: 'ignore',
                    env: childEnvironment,
                },
            );
            child.unref();
            const started = await waitForDaemon(paths);
            if (versionOrder(started, options) !== 0) {
                throw new DaemonVersionError(
                    `Started daemon ${started.version} does not match client ${options.clientVersion}. Update the LeafRelay installation and retry.`,
                );
            }
            return started;
        } finally {
            await rm(paths.startupLockPath, { recursive: true, force: true });
        }
    }
    // The lock owner may be draining an old daemon. Do not attach to it.
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
        const metadata = await waitForDaemon(paths);
        const order = versionOrder(metadata, options);
        if (order > 0) {
            throw newerDaemonError(metadata, options);
        }
        if (order === 0) {
            return metadata;
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, START_POLL_MS));
    }
    throw new Error('Timed out waiting for the LeafRelay daemon upgrade.');
}

async function waitForDaemon(paths: DaemonPaths): Promise<DaemonMetadata> {
    const deadline = Date.now() + START_TIMEOUT_MS;
    let lastError: unknown;
    while (Date.now() < deadline) {
        try {
            const metadata = await readMetadata(paths);
            if (
                metadata &&
                (await tryConnect(metadata).then((socket) => {
                    socket?.destroy();
                    return Boolean(socket);
                }))
            ) {
                return metadata;
            }
        } catch (pollError) {
            lastError = pollError;
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, START_POLL_MS));
    }
    throw new Error(`LeafRelay daemon did not start within ${START_TIMEOUT_MS}ms.`, { cause: lastError });
}

async function readMetadata(paths: DaemonPaths): Promise<DaemonMetadata | undefined> {
    try {
        return JSON.parse(await readFile(paths.metadataPath, 'utf8')) as DaemonMetadata;
    } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === 'ENOENT') {
            return undefined;
        }
        throw readError;
    }
}

async function tryConnect(metadata: DaemonMetadata): Promise<Socket | undefined> {
    return new Promise((resolveConnection) => {
        const socket = connect(metadata.socketPath);
        socket.once('connect', () => resolveConnection(socket));
        socket.once('error', () => {
            socket.destroy();
            resolveConnection(undefined);
        });
    });
}

export class DaemonVersionError extends Error {}

function versionOrder(metadata: DaemonMetadata, options: DaemonClientOptions): number {
    // Development/test clients have no release version to enforce.
    return valid(metadata.version) && valid(options.clientVersion)
        ? compare(metadata.version, options.clientVersion)
        : 0;
}

function newerDaemonError(metadata: DaemonMetadata, options: DaemonClientOptions): Error {
    return new DaemonVersionError(
        `LeafRelay daemon ${metadata.version} is newer than this ${options.clientName} client (${options.clientVersion}). Update ${options.clientName === 'vscode' ? 'the LeafRelay VS Code extension' : 'LeafRelay (npm install -g leafrelay@latest)'} and retry.`,
    );
}

async function isListening(metadata: DaemonMetadata): Promise<boolean> {
    const socket = await tryConnect(metadata);
    socket?.destroy();
    return Boolean(socket);
}

async function stopForUpgrade(
    paths: DaemonPaths,
    metadata: DaemonMetadata,
    options: DaemonClientOptions,
): Promise<void> {
    const socket = await tryConnect(metadata);
    if (!socket) {
        return;
    }
    const rpc = createSocketRpcConnection(socket);
    rpc.listen();
    let timer: NodeJS.Timeout | undefined;
    try {
        await Promise.race([
            (async () => {
                // Use the old protocol only to authenticate shutdown. Project
                // operations always use the client's current protocol.
                await rpc.sendRequest(RPC_METHOD.initialize, {
                    token: metadata.token,
                    clientId: randomUUID(),
                    clientName: options.clientName,
                    clientVersion: options.clientVersion,
                    protocolVersion: metadata.protocolVersion,
                } satisfies InitializeParams);
                await rpc.sendRequest(RPC_METHOD.daemonShutdown);
                const deadline = Date.now() + START_TIMEOUT_MS;
                while (Date.now() < deadline) {
                    const current = await readMetadata(paths);
                    if (!current || current.token !== metadata.token) {
                        return;
                    }
                    await new Promise((resolveWait) => setTimeout(resolveWait, START_POLL_MS));
                }
                throw new Error('Old LeafRelay daemon did not finish shutting down.');
            })(),
            new Promise<never>((_, reject) => {
                timer = setTimeout(
                    () => reject(new Error('Timed out stopping the old LeafRelay daemon.')),
                    START_TIMEOUT_MS,
                );
            }),
        ]);
    } finally {
        if (timer) {
            clearTimeout(timer);
        }
        rpc.dispose();
        socket.destroy();
    }
}
