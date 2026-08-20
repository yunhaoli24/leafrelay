import {
    ExtendedBaseAPI,
    HttpRequestScheduler,
    RemoteProject,
    SocketIOAPI,
    getServerSession,
    normalizeServerUrl,
    readConfig,
    removeKnownServer,
    removeServerSession,
    saveKnownServer,
    saveServerSession,
    serverKey,
    type Identity,
    type ServerSession,
} from '@leafrelay/core';
import type {
    ProjectEventNotification,
    ProjectOpenResult,
    ServerDescriptor,
    ServerImportParams,
    ServerLoginParams,
} from '@leafrelay/protocol';

const PROJECT_IDLE_MS = 60_000;

const SERVER_OPERATIONS = new Set([
    'userProjectsJson', 'getProjectsJson', 'projectEntitiesJson',
    'newProject', 'cloneProject', 'renameProject', 'deleteProject',
    'archiveProject', 'unarchiveProject', 'trashProject', 'untrashProject',
    'getFile', 'addDoc', 'uploadFile', 'uploadProject', 'addFolder',
    'deleteEntity', 'deleteAuxFiles', 'renameEntity', 'moveEntity',
    'compile', 'stopCompile', 'indexAll', 'getMetadata',
    'proxyRequestToSpellingApi', 'spellingControllerLearn', 'spellingControllerUnlearn',
    'getProjectSettings', 'updateProjectSettings', 'getFileFromClsi',
    'proxySyncPdf', 'proxySyncCode', 'getAllTags', 'createTag', 'renameTag',
    'deleteTag', 'addProjectToTag', 'removeProjectFromTag',
    'proxyToHistoryApiAndGetUpdates', 'proxyToHistoryApiAndGetFileDiff',
    'proxyToHistoryApiAndGetFileTreeDiff', 'downloadZipOfVersion',
    'getLabels', 'createLabel', 'deleteLabel', 'getMessages', 'sendMessage',
    'refreshLinkedFile', 'createLinkedFile',
]);

const PROJECT_OPERATIONS = new Set([
    'init', 'joinProject', 'joinDoc', 'leaveDoc', 'applyOtUpdate',
    'getConnectedUsers', 'updatePosition', 'syncFileChanges',
]);

interface ServerRuntime {
    key:string;
    session:ServerSession;
    scheduler:HttpRequestScheduler;
    api:ExtendedBaseAPI;
}

interface ProjectRuntime {
    key:string;
    server:ServerRuntime;
    projectId:string;
    socket:SocketIOAPI;
    remote:RemoteProject;
    ready:Promise<void>;
    owners:Set<string>;
    replicaReferences:number;
    idleTimer?:NodeJS.Timeout;
}

export interface ProjectLease {
    remote:RemoteProject;
    release():void;
}

export interface NetworkRuntimeEvents {
    projectEvent:(owners:ReadonlySet<string>, event:ProjectEventNotification) => void;
    log:(level:'info'|'warn'|'error', message:string) => void;
}

export class NetworkRuntimeRegistry {
    private readonly servers = new Map<string,ServerRuntime>();
    private readonly projects = new Map<string,ProjectRuntime>();

    constructor(private readonly events:NetworkRuntimeEvents) {}

    get projectCount():number { return this.projects.size; }

    async listServers():Promise<ServerDescriptor[]> {
        const config = await readConfig();
        const keys = new Set([...Object.keys(config.knownServers ?? {}), ...Object.keys(config.servers)]);
        if (keys.size===0) { keys.add('www.overleaf.com'); }
        return [...keys].sort().map(key => {
            const session = config.servers[key];
            const known = config.knownServers?.[key];
            return {
                name:known?.name ?? key,
                url:known?.url ?? session?.url ?? normalizeServerUrl(key),
                loggedIn:Boolean(session),
                userId:session?.userId,
                userEmail:session?.userEmail,
            };
        });
    }

    async addServer(name:string, url:string):Promise<void> {
        await saveKnownServer(name, url);
    }

    async removeServer(server:string):Promise<void> {
        const key = serverKey(server);
        for (const project of this.projects.values()) {
            if (project.server.key===key) { await this.stopProject(project); }
        }
        this.servers.delete(key);
        await removeKnownServer(server);
    }

    async login(params:ServerLoginParams) {
        const url = normalizeServerUrl(params.server);
        const scheduler = new HttpRequestScheduler({
            onRateLimit:until => this.events.log('warn', `${serverKey(url)} is rate limited until ${new Date(until).toISOString()}.`),
        });
        const api = new ExtendedBaseAPI(url, scheduler);
        const response = params.cookie
            ? await api.cookiesLogin(params.cookie)
            : await api.passportLogin(params.email ?? '', params.password ?? '');
        if (response.type!=='success' || !response.identity || !response.userInfo) {
            throw new Error(response.message || `Login to ${url} failed.`);
        }
        const session:ServerSession = {
            url,
            userId:response.userInfo.userId,
            userEmail:response.userInfo.userEmail || params.email || '',
            identity:response.identity,
            updatedAt:new Date().toISOString(),
        };
        await saveServerSession(session);
        this.servers.set(serverKey(url), {key:serverKey(url), session, scheduler, api});
        return {userId:session.userId, userEmail:session.userEmail};
    }

    async importSession(params:ServerImportParams) {
        const result = await this.login({server:params.url, cookie:params.identity.cookies});
        await saveKnownServer(params.name, params.url);
        return result;
    }

    async logout(server:string):Promise<void> {
        const runtime = await this.requireServer(server);
        await runtime.api.logout(runtime.session.identity);
        await removeServerSession(server);
        this.servers.delete(runtime.key);
    }

    async callServer(server:string, operation:string, args:unknown[]):Promise<unknown> {
        if (!SERVER_OPERATIONS.has(operation)) { throw new Error(`Unsupported server operation: ${operation}.`); }
        const runtime = await this.requireServer(server);
        const method = (runtime.api as unknown as Record<string,unknown>)[operation];
        if (typeof method!=='function') { throw new Error(`Server operation ${operation} is unavailable.`); }
        return (method as (...values:unknown[]) => Promise<unknown>).call(runtime.api, runtime.session.identity, ...args);
    }

    async openProject(clientId:string, server:string, projectId:string):Promise<ProjectOpenResult> {
        const runtime = await this.getOrCreateProject(server, projectId);
        const shared = runtime.owners.size!==0 || runtime.replicaReferences!==0;
        if (runtime.idleTimer) { clearTimeout(runtime.idleTimer); runtime.idleTimer = undefined; }
        runtime.owners.add(clientId);
        await runtime.ready;
        return {projectKey:runtime.key, shared};
    }

    closeProject(clientId:string, projectKey:string):void {
        const runtime = this.requireProject(projectKey);
        runtime.owners.delete(clientId);
        this.scheduleProjectStop(runtime);
    }

    async callProject(projectKey:string, operation:string, args:unknown[]):Promise<unknown> {
        if (!PROJECT_OPERATIONS.has(operation)) { throw new Error(`Unsupported project operation: ${operation}.`); }
        const runtime = this.requireProject(projectKey);
        await runtime.ready;
        const method = (runtime.socket as unknown as Record<string,unknown>)[operation];
        if (typeof method!=='function') { throw new Error(`Project operation ${operation} is unavailable.`); }
        return (method as (...values:unknown[]) => unknown).apply(runtime.socket, args);
    }

    async acquireReplica(server:string, projectId:string):Promise<ProjectLease> {
        const runtime = await this.getOrCreateProject(server, projectId);
        if (runtime.idleTimer) { clearTimeout(runtime.idleTimer); runtime.idleTimer = undefined; }
        runtime.replicaReferences += 1;
        await runtime.ready;
        let released = false;
        return {
            remote:runtime.remote,
            release:() => {
                if (released) { return; }
                released = true;
                runtime.replicaReferences -= 1;
                this.scheduleProjectStop(runtime);
            },
        };
    }

    detachClient(clientId:string):void {
        for (const runtime of this.projects.values()) {
            if (runtime.owners.delete(clientId)) { this.scheduleProjectStop(runtime); }
        }
    }

    async stopAll():Promise<void> {
        await Promise.all([...this.projects.values()].map(runtime => this.stopProject(runtime)));
        this.servers.clear();
    }

    private async requireServer(server:string):Promise<ServerRuntime> {
        const key = serverKey(server);
        const existing = this.servers.get(key);
        if (existing) { return existing; }
        const session = await getServerSession(server);
        if (!session) { throw new Error(`Not logged in to ${key}.`); }
        const scheduler = new HttpRequestScheduler({
            onRateLimit:until => this.events.log('warn', `${key} is rate limited until ${new Date(until).toISOString()}.`),
        });
        const runtime = {key, session, scheduler, api:new ExtendedBaseAPI(session.url, scheduler)};
        this.servers.set(key, runtime);
        return runtime;
    }

    private async getOrCreateProject(server:string, projectId:string):Promise<ProjectRuntime> {
        const serverRuntime = await this.requireServer(server);
        const key = `${serverRuntime.key}:${projectId}`;
        const existing = this.projects.get(key);
        if (existing) { return existing; }
        const socket = new SocketIOAPI(serverRuntime.session.url, serverRuntime.api, serverRuntime.session.identity, projectId);
        const remote = new RemoteProject(
            serverRuntime.session.url,
            projectId,
            serverRuntime.session.identity.cookies,
            {api:serverRuntime.api, identity:serverRuntime.session.identity, socket},
        );
        const runtime:ProjectRuntime = {
            key,
            server:serverRuntime,
            projectId,
            socket,
            remote,
            ready:Promise.resolve(),
            owners:new Set(),
            replicaReferences:0,
        };
        runtime.ready = remote.connect().then(() => this.registerProjectEvents(runtime)).catch(error => {
            this.projects.delete(key);
            socket.disconnect();
            throw error;
        });
        this.projects.set(key, runtime);
        return runtime;
    }

    private registerProjectEvents(runtime:ProjectRuntime):void {
        const emit = (event:string, ...args:unknown[]) => this.events.projectEvent(runtime.owners, {
            projectKey:runtime.key,
            event,
            args,
        });
        runtime.socket.updateEventHandlers({
            onFileCreated:(...args) => emit('onFileCreated', ...args),
            onFileRenamed:(...args) => emit('onFileRenamed', ...args),
            onFileRemoved:(...args) => emit('onFileRemoved', ...args),
            onFileMoved:(...args) => emit('onFileMoved', ...args),
            onFileChanged:(...args) => emit('onFileChanged', ...args),
            onDisconnected:() => emit('onDisconnected'),
            onConnectionAccepted:(...args) => emit('onConnectionAccepted', ...args),
            onClientUpdated:(...args) => emit('onClientUpdated', ...args),
            onClientDisconnected:(...args) => emit('onClientDisconnected', ...args),
            onReceivedMessage:(...args) => emit('onReceivedMessage', ...args),
            onSpellCheckLanguageUpdated:(...args) => emit('onSpellCheckLanguageUpdated', ...args),
            onCompilerUpdated:(...args) => emit('onCompilerUpdated', ...args),
            onRootDocUpdated:(...args) => emit('onRootDocUpdated', ...args),
        });
    }

    private requireProject(projectKey:string):ProjectRuntime {
        const runtime = this.projects.get(projectKey);
        if (!runtime) { throw new Error(`Unknown project runtime ${projectKey}.`); }
        return runtime;
    }

    private scheduleProjectStop(runtime:ProjectRuntime):void {
        if (runtime.owners.size!==0 || runtime.replicaReferences!==0 || runtime.idleTimer) { return; }
        runtime.idleTimer = setTimeout(() => void this.stopProject(runtime), PROJECT_IDLE_MS);
        runtime.idleTimer.unref();
    }

    private async stopProject(runtime:ProjectRuntime):Promise<void> {
        if (!this.projects.delete(runtime.key)) { return; }
        if (runtime.idleTimer) { clearTimeout(runtime.idleTimer); }
        runtime.socket.disconnect();
    }
}
