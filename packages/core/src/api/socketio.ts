/* eslint-disable @typescript-eslint/naming-convention */
import { Identity, BaseAPI, ProjectMessageResponseSchema } from './base';
import { FileEntity, DocumentEntity, FileRefEntity, FileType, FolderEntity, ProjectEntity } from '../core/projectTypes';
import { error as logError, log } from '../core/logger';
import { promisify } from 'node:util';

const SOCKET_OPERATION_TIMEOUT_MS = 15000;

function decodePackedUtf8(text: string): string {
    return Buffer.from(text, 'latin1').toString('utf-8');
}

export interface UpdateUserSchema {
    id: string,
    user_id: string,
    name: string,
    email: string,
    doc_id: string,
    row: number,
    column: number,
    last_updated_at?: number, //unix timestamp
}

export interface OnlineUserSchema {
    client_age: number,
    client_id: string,
    connected: boolean,
    cursorData?: {
        column: number,
        doc_id: string,
        row: number,
    },
    email: string,
    first_name: string,
    last_name?: string,
    last_updated_at: string, //unix timestamp
    user_id: string,
}

export interface UpdateSchema {
    doc: string, //doc id
    op?: {
        p: number, //position
        i?: string, //insert
        d?: string, //delete
        u?: boolean, //isUndo
    }[],
    v: number, //doc version number
    lastV?: number, //last version number
    hash?: string, //(not needed if lastV is provided)
    meta?: {
        source: string, //socketio client id
        ts: number, //unix timestamp
        user_id: string,
    }
}

export interface EventsHandler {
    onFileCreated?: (parentFolderId:string, type:FileType, entity:FileEntity) => void,
    onFileRenamed?: (entityId:string, newName:string) => void,
    onFileRemoved?: (entityId:string) => void,
    onFileMoved?: (entityId:string, newParentFolderId:string) => void,
    onFileChanged?: (update:UpdateSchema) => void,
    //
    onDisconnected?: () => void,
    onConnectionAccepted?: (publicId:string) => void,
    onClientUpdated?: (user:UpdateUserSchema) => void,
    onClientDisconnected?: (id:string) => void,
    //
    onReceivedMessage?: (message:ProjectMessageResponseSchema) => void,
    //
    onSpellCheckLanguageUpdated?: (language:string) => void,
    onCompilerUpdated?: (compiler:string) => void,
    onRootDocUpdated?: (rootDocId:string) => void,
}

export interface ProjectSocket {
    readonly needsReinit:boolean;
    readonly connectionScheme:'Alt'|'realtime';
    init():void;
    disconnect():void;
    updateEventHandlers(handlers:EventsHandler):void;
    joinProject(projectId:string):Promise<ProjectEntity>;
    joinDoc(docId:string):Promise<{docLines:string[]; version:number; updates:unknown[]; ranges:unknown}>;
    leaveDoc(docId:string):Promise<void>;
    applyOtUpdate(docId:string, update:UpdateSchema):Promise<void>;
    getConnectedUsers():Promise<OnlineUserSchema[]>;
    updatePosition(docId:string, row:number, column:number):Promise<void>;
}

type ConnectionScheme = 'Alt' | 'realtime';
type AlternativeSocketFactory = (
    url:string,
    api:BaseAPI,
    identity:Identity,
    projectId:string,
    record:Promise<ProjectEntity>,
) => any;

export class SocketIOAPI implements ProjectSocket {
    private static alternativeSocketFactory?: AlternativeSocketFactory;
    private scheme: ConnectionScheme;
    private record?: Promise<ProjectEntity>;
    private _handlers: Array<EventsHandler> = [];
    private connectedPublicId?: string;

    private socket?: any;
    private emit: any;
    /** Track the scheme used when the socket was last initialized */
    private _socketInitScheme?: ConnectionScheme;

    constructor(private url:string,
                private readonly api:BaseAPI,
                private readonly identity:Identity,
                private readonly projectId:string)
    {
        this.scheme = 'realtime';
        this.init();
    }

    static setAlternativeSocketFactory(factory: AlternativeSocketFactory) {
        SocketIOAPI.alternativeSocketFactory = factory;
    }

    init() {
        // CRITICAL: Properly disconnect old socket before creating a new one.
        // Without this, the old TCP connection is abandoned but still alive. When the
        // server later sends data on it (out-of-order/late packets), the OS TCP stack
        // responds with RST, which can cause the server to drop ALL connections from
        // this client — explaining the "connection lost" loop reported in issue #309.
        if (this.socket) {
            try {
                // Remove all listeners to prevent stale event handlers from firing
                if (typeof this.socket.removeAllListeners === 'function') {
                    this.socket.removeAllListeners();
                }
                // Gracefully close the connection (sends FIN, not RST)
                if (typeof this.socket.disconnect === 'function') {
                    this.socket.disconnect();
                }
            } catch {
                // Best-effort cleanup; socket may already be in a bad state
            }
        }

        // connect
        switch(this.scheme) {
            case 'Alt':
                if (!SocketIOAPI.alternativeSocketFactory) {
                    throw new Error('The alternative Overleaf connection is not available in this runtime.');
                }
                this.socket = SocketIOAPI.alternativeSocketFactory(
                    this.url, this.api, this.identity, this.projectId, this.record!,
                );
                break;
            case 'realtime':
                this.record = undefined;
                const query = `?projectId=${this.projectId}&t=${Date.now()}`;
                this.socket = this.api._initSocketV0(this.identity, query);
                break;
        }
        // create emit
        (this.socket.emit)[promisify.custom] = (event:string, ...args:any[]) => {
            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => {
                    reject('timeout');
                }, SOCKET_OPERATION_TIMEOUT_MS);
            });
            const waitPromise = new Promise((resolve, reject) => {
                this.socket.emit(event, ...args, (err:any, ...data:any[]) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(data);
                    }
                });
            });
            return Promise.race([waitPromise, timeoutPromise]);
        };
        this.emit = promisify(this.socket.emit).bind(this.socket);
        // resume handlers
        this.initInternalHandlers();
        // Re-register existing event handlers on the new socket
        this.resumeEventHandlers(this._handlers);
        // Track which scheme this socket was created with
        this._socketInitScheme = this.scheme;
    }

    /** Returns true if the socket needs re-initialization (scheme changed, or socket was never init'd) */
    get needsReinit(): boolean {
        return this._socketInitScheme !== this.scheme || !this.socket;
    }

    get connectionScheme(): ConnectionScheme {
        return this.scheme;
    }

    private initInternalHandlers() {
        this.socket.on('connect', () => {
            log('SocketIOAPI: connected', {scheme: this.scheme, projectId: this.projectId});
        });
        this.socket.on('connect_failed', (connectionError:any) => {
            log('SocketIOAPI: connect_failed', {scheme: this.scheme, projectId: this.projectId, error: connectionError});
        });
        this.socket.on('disconnect', (reason:any) => {
            log('SocketIOAPI: disconnect event', {scheme: this.scheme, projectId: this.projectId, reason});
        });
        this.socket.on('reconnecting', (delay:any, attempt:any) => {
            log('SocketIOAPI: reconnecting', {scheme: this.scheme, projectId: this.projectId, delay, attempt});
        });
        this.socket.on('reconnect', (transport:any, attempts:any) => {
            log('SocketIOAPI: reconnected', {scheme: this.scheme, projectId: this.projectId, transport, attempts});
        });
        this.socket.on('reconnect_failed', (error:any) => {
            log('SocketIOAPI: reconnect_failed', {scheme: this.scheme, projectId: this.projectId, error});
        });
        this.socket.on('forceDisconnect', (message:string, delay=10) => {
            log('SocketIOAPI: forceDisconnect', {message, delay, projectId: this.projectId});
        });
        this.socket.on('connectionRejected', (err:any) => {
            log('SocketIOAPI: connectionRejected', {scheme: this.scheme, projectId: this.projectId, error: err});
            // Disable auto-reconnect on this socket: the server explicitly rejected
            // our connection parameters. Reconnecting would just get rejected again,
            // creating unnecessary TCP connection churn (and RST packets).
            if (this.socket.io && typeof this.socket.io.reconnect === 'function') {
                this.socket.io.reconnect(false);
            }
        });
        this.socket.on('error', (err:any) => {
            // Log error instead of throwing to avoid crashing the extension
            const message = err?.message || String(err);
            logError(`Overleaf connection error: ${message}`);
        });

        if (this.scheme==='realtime') {
            this.record = new Promise((resolve, reject) => {
                this.socket.on('joinProjectResponse', (res:any) => {
                    const publicId = res.publicId as string;
                    const project = res.project as ProjectEntity;
                    this.connectedPublicId = publicId;
                    for (const handler of this._handlers) {
                        handler.onConnectionAccepted?.(publicId);
                    }
                    resolve(project);
                });
                this.socket.on('connectionRejected', (err:any) => {
                    reject(err?.message || err);
                });
            });
        }
    }

    disconnect() {
        this.socket.disconnect();
    }

    get handlers() {
        return this._handlers;
    }

    get isUsingAlternativeConnectionScheme() {
        return this.scheme==='Alt';
    }

    toggleAlternativeConnectionScheme(url: string, updatedRecord?: ProjectEntity) {
        this.scheme = this.scheme==='Alt' ? 'realtime' : 'Alt';
        if (updatedRecord) {
            this.url = url;
            this.record = Promise.resolve(updatedRecord);
        }
    }

    resumeEventHandlers(handlers: Array<EventsHandler>) {
        this._handlers = [];
        handlers.forEach((handler) => {
            this.updateEventHandlers(handler);
        });
    }

    updateEventHandlers(handlers: EventsHandler) {
        this._handlers.push(handlers);
        Object.values(handlers).forEach((handler) => {
            switch (handler) {
                case handlers.onFileCreated:
                    this.socket.on('reciveNewDoc', (parentFolderId:string, doc:DocumentEntity) => {
                        handler(parentFolderId, 'doc', doc);
                    });
                    this.socket.on('reciveNewFile', (parentFolderId:string, file:FileRefEntity) => {
                        handler(parentFolderId, 'file', file);
                    });
                    this.socket.on('reciveNewFolder', (parentFolderId:string, folder:FolderEntity) => {
                        handler(parentFolderId, 'folder', folder);
                    });
                    break;
                case handlers.onFileRenamed:
                    this.socket.on('reciveEntityRename', (entityId:string, newName:string) => {
                        handler(entityId, newName);
                    });
                    break;
                case handlers.onFileRemoved:
                    this.socket.on('removeEntity', (entityId:string) => {
                        handler(entityId);
                    });
                    break;
                case handlers.onFileMoved:
                    this.socket.on('reciveEntityMove', (entityId:string, folderId:string) => {
                        handler(entityId, folderId);
                    });
                    break;
                case handlers.onFileChanged:
                    this.socket.on('otUpdateApplied', (update: UpdateSchema) => {
                        handler(update);
                    });
                    break;
                case handlers.onDisconnected:
                    this.socket.on('disconnect', () => {
                        handler();
                    });
                    break;
                case handlers.onConnectionAccepted:
                    this.socket.on('connectionAccepted', (_:any, publicId:any) => {
                        handler(publicId);
                    });
                    if (this.connectedPublicId!==undefined) {
                        queueMicrotask(() => handler(this.connectedPublicId!));
                    }
                    break;
                case handlers.onClientUpdated:
                    this.socket.on('clientTracking.clientUpdated', (user:UpdateUserSchema) => {
                        handler(user);
                    });
                    break;
                case handlers.onClientDisconnected:
                    this.socket.on('clientTracking.clientDisconnected', (id:string) => {
                        handler(id);
                    });
                    break;
                case handlers.onReceivedMessage:
                    this.socket.on('new-chat-message', (message:ProjectMessageResponseSchema) => {
                        handler(message);
                    });
                    break;
                case handlers.onSpellCheckLanguageUpdated:
                    this.socket.on('spellCheckLanguageUpdated', (language:string) => {
                        handler(language);
                    });
                    break;
                case handlers.onCompilerUpdated:
                    this.socket.on('compilerUpdated', (compiler:string) => {
                        handler(compiler);
                    });
                    break;
                case handlers.onRootDocUpdated:
                    this.socket.on('rootDocUpdated', (rootDocId:string) => {
                        handler(rootDocId);
                    });
                    break;
                default:
                    break;
            }
        });
    }

    get unSyncFileChanges(): number {
        return this.scheme==='Alt' ? this.socket.unSyncedChanges : 0;
    }

    async syncFileChanges() {
        if (this.scheme==='Alt') {
            return await this.socket.uploadToVFS();
        }
    }

    /**
     * Reference: services/web/frontend/js/ide/connection/ConnectionManager.js#L427
     * @param {string} projectId - The project id.
     * @returns {Promise}
     */
    async joinProject(project_id:string): Promise<ProjectEntity> {
        const timeoutPromise: Promise<ProjectEntity> = new Promise((_, reject) => {
            setTimeout(() => {
                reject('timeout');
            }, SOCKET_OPERATION_TIMEOUT_MS);
        });

        switch(this.scheme) {
            case 'Alt':
                return Promise.race([
                    this.emit('joinProject', {project_id}).then((returns:[ProjectEntity]) => returns[0]),
                    timeoutPromise,
                ]);
            case 'realtime':
                return Promise.race([this.record!, timeoutPromise]);
        }
    }

    /**
     * Reference: services/web/frontend/js/ide/editor/Document.js#L500
     * @param {string} docId - The document id.
     * @returns {Promise}
     */
    async joinDoc(docId:string) {
        return this.emit('joinDoc', docId, { encodeRanges: true })
            .then((returns: [Array<string>, number, Array<any>, any]) => {
                const [docLinesAscii, version, updates, ranges] = returns;
                const docLines = docLinesAscii.map((line) => decodePackedUtf8(line));
                return {docLines, version, updates, ranges};
            });
    }

    /**
     * Reference: services/web/frontend/js/ide/editor/Document.js#L591
     * @param {string} docId - The document id.
     * @returns {Promise}
     */
    async leaveDoc(docId:string) {
        return this.emit('leaveDoc', docId)
            .then(() => {
                return;
            });
    }

    /**
     * Reference: services/web/frontend/js/ide/editor/ShareJsDocs.js#L78
     * @param {string} docId - The document id.
     * @param {any} update - The changes.
     * @returns {Promise}
     */
    async applyOtUpdate(docId:string, update:UpdateSchema) {
        try {
            await this.emit('applyOtUpdate', docId, update);
        } catch (error) {
            let detail: string;
            if (error instanceof Error) {
                detail = error.message;
            } else if (typeof error==='string') {
                detail = error;
            } else {
                try { detail = JSON.stringify(error); } catch { detail = String(error); }
            }
            throw new Error(`Overleaf document update rejected: ${detail}`);
        }
    }

    /**
     * Reference: services/web/frontend/js/ide/online-users/OnlineUserManager.js#L42
     * @returns {Promise}
     */
    async getConnectedUsers(): Promise<OnlineUserSchema[]> {
        return this.emit('clientTracking.getConnectedUsers')
            .then((returns:[OnlineUserSchema[]]) => {
                const [connectedUsers] = returns;
                return connectedUsers;
            });
    }

    /**
     * Reference: services/web/frontend/js/ide/online-users/OnlineUserManager.js#L150
     * @param {string} docId - The document id.
     * @returns {Promise}
     */
    async updatePosition(doc_id:string, row:number, column:number) {
        return this.emit('clientTracking.updatePosition', {row, column, doc_id})
            .then(() => {
                return;
            });
    }
}
