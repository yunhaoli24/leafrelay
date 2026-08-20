export const LEAFRELAY_PROTOCOL_VERSION = 1;

export const RPC_METHOD = {
    initialize:'leafrelay/initialize',
    daemonStatus:'leafrelay/daemon/status',
    daemonShutdown:'leafrelay/daemon/shutdown',
    replicaAttach:'leafrelay/replica/attach',
    replicaDetach:'leafrelay/replica/detach',
    replicaResolveConflict:'leafrelay/replica/resolveConflict',
    replicaRetry:'leafrelay/replica/retry',
    sessionImport:'leafrelay/session/import',
    sessionLogin:'leafrelay/session/login',
    sessionLogout:'leafrelay/session/logout',
    serverList:'leafrelay/server/list',
    serverAdd:'leafrelay/server/add',
    serverRemove:'leafrelay/server/remove',
    serverCall:'leafrelay/server/call',
    projectOpen:'leafrelay/project/open',
    projectClose:'leafrelay/project/close',
    projectCall:'leafrelay/project/call',
} as const;

export const RPC_NOTIFICATION = {
    log:'leafrelay/log',
    replicaStatus:'leafrelay/replica/status',
    replicaConflict:'leafrelay/replica/conflict',
    projectEvent:'leafrelay/project/event',
} as const;

export interface InitializeParams {
    token:string;
    clientId:string;
    clientName:'cli'|'vscode'|'library'|'test';
    clientVersion:string;
    protocolVersion:number;
}

export interface InitializeResult {
    daemonVersion:string;
    protocolVersion:number;
    pid:number;
    startedAt:string;
}

export interface DaemonStatus {
    pid:number;
    version:string;
    protocolVersion:number;
    startedAt:string;
    clients:number;
    projects:number;
    replicas:Array<{
        id:string;
        root:string;
        serverName:string;
        projectId:string;
        projectName:string;
        clients:number;
        status:ReplicaStatus;
        conflicts:string[];
    }>;
}

export type ReplicaState = 'starting'|'syncing'|'active'|'paused'|'stopping'|'error';

export interface ReplicaStatus {
    state:ReplicaState;
    message?:string;
}

export interface ReplicaAttachParams {
    directory:string;
    cookie?:string;
}

export interface ReplicaAttachResult {
    replicaId:string;
    root:string;
    serverName:string;
    projectId:string;
    projectName:string;
    shared:boolean;
    status:ReplicaStatus;
    conflicts:string[];
}

export interface ReplicaConflictResolutionParams {
    replicaId:string;
    path:string;
    winner:'local'|'remote';
}

export interface ReplicaStatusNotification {
    replicaId:string;
    status:ReplicaStatus;
}

export interface ReplicaConflictNotification {
    replicaId:string;
    path:string;
    reason:string;
    conflicts:string[];
}

export interface LogNotification {
    timestamp:string;
    level:'info'|'warn'|'error';
    message:string;
}

export interface DaemonMetadata {
    pid:number;
    socketPath:string;
    token:string;
    protocolVersion:number;
    version:string;
    startedAt:string;
}

export interface ServerDescriptor {
    name:string;
    url:string;
    loggedIn:boolean;
    userId?:string;
    userEmail?:string;
}

export interface ServerLoginParams {
    server:string;
    cookie?:string;
    email?:string;
    password?:string;
}

export interface ServerImportParams {
    name:string;
    url:string;
    userId:string;
    userEmail:string;
    identity:{cookies:string; csrfToken:string};
}

export interface ServerCallParams {
    server:string;
    operation:string;
    args:unknown[];
}

export interface ProjectOpenParams {
    server:string;
    projectId:string;
}

export interface ProjectOpenResult {
    projectKey:string;
    shared:boolean;
}

export interface ProjectCallParams {
    projectKey:string;
    operation:string;
    args:unknown[];
}

export interface ProjectEventNotification {
    projectKey:string;
    event:string;
    args:unknown[];
}

export interface EncodedBinary {
    $leafrelay:'bytes';
    base64:string;
}
