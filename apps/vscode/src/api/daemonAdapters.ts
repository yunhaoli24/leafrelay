import type {
    BaseAPI,
    EventsHandler,
    OnlineUserSchema,
    ProjectEntity,
    ProjectSocket,
    UpdateSchema,
} from '@leafrelay/core';
import type {DaemonClientListener, LeafRelayDaemonClient} from '@leafrelay/daemon';

const API_OPERATIONS = new Set([
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

export function createDaemonApi(client:LeafRelayDaemonClient, server:string, url:string):BaseAPI {
    return new Proxy({url}, {
        get(target, property) {
            if (property==='url') { return target.url; }
            if (typeof property==='string' && API_OPERATIONS.has(property)) {
                return (_identity:unknown, ...args:unknown[]) => client.callServer(server, property, args);
            }
            return undefined;
        },
    }) as unknown as BaseAPI;
}

export class DaemonProjectSocket implements ProjectSocket {
    private readonly projectKey:Promise<string>;
    private readonly eventListener:DaemonClientListener;
    private readonly handlers:EventsHandler[] = [];
    private closed = false;

    readonly needsReinit = false;
    readonly connectionScheme = 'realtime' as const;

    constructor(
        private readonly client:LeafRelayDaemonClient,
        private readonly server:string,
        private readonly projectId:string,
    ) {
        this.projectKey = client.openProject(server, projectId).then(result => result.projectKey);
        this.eventListener = client.onProjectEvent(event => {
            void this.projectKey.then(projectKey => {
                if (event.projectKey!==projectKey || this.closed) { return; }
                for (const handler of this.handlers) {
                    const callback = handler[event.event as keyof EventsHandler];
                    if (typeof callback==='function') {
                        (callback as (...args:unknown[]) => void)(...event.args);
                    }
                }
            });
        });
    }

    init():void {}

    disconnect():void {
        if (this.closed) { return; }
        this.closed = true;
        this.eventListener.dispose();
        void this.projectKey.then(projectKey => this.client.closeProject(projectKey));
    }

    updateEventHandlers(handlers:EventsHandler):void {
        this.handlers.push(handlers);
    }

    async joinProject(projectId:string):Promise<ProjectEntity> {
        return this.call('joinProject', [projectId]);
    }

    async joinDoc(docId:string) {
        return this.call<{docLines:string[]; version:number; updates:unknown[]; ranges:unknown}>('joinDoc', [docId]);
    }

    async leaveDoc(docId:string):Promise<void> {
        await this.call('leaveDoc', [docId]);
    }

    async applyOtUpdate(docId:string, update:UpdateSchema):Promise<void> {
        await this.call('applyOtUpdate', [docId, update]);
    }

    getConnectedUsers():Promise<OnlineUserSchema[]> {
        return this.call('getConnectedUsers');
    }

    async updatePosition(docId:string, row:number, column:number):Promise<void> {
        await this.call('updatePosition', [docId, row, column]);
    }

    private async call<T=unknown>(operation:string, args:unknown[]=[]):Promise<T> {
        return this.client.callProject<T>(await this.projectKey, operation, args);
    }
}
