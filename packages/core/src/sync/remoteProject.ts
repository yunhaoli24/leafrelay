import {createHash} from 'node:crypto';
import {posix} from 'node:path';
import DiffMatchPatch from 'diff-match-patch';
import {BaseAPI, type Identity, type ProjectFileTreeDiffResponseSchema} from '../api/base';
import {SocketIOAPI, type UpdateSchema} from '../api/socketio';
import type {
    DocumentEntity,
    FileEntity,
    FileRefEntity,
    FileType,
    FolderEntity,
    ProjectEntity,
} from '../core/projectTypes';

export interface RemoteEntry {
    path: string;
    type: FileType;
    entity: FileEntity;
    parent?: FolderEntity;
}

export type RemoteChange = {path:string; previousPath?:string; actor?:string};

export interface RemoteProjectTransport {
    api:BaseAPI;
    identity:Identity;
    socket:SocketIOAPI;
}

function normalizePath(path: string): string {
    const normalized = `/${posix.normalize(path).replace(/^\/+/, '')}`;
    if (normalized.includes('/../') || normalized.endsWith('/..')) {
        throw new Error(`Invalid project path: ${path}`);
    }
    return normalized;
}

function textContent(content: Uint8Array): string | undefined {
    if (content.includes(0)) { return undefined; }
    try {
        return new TextDecoder('utf-8', {fatal:true}).decode(content);
    } catch {
        return undefined;
    }
}

export class RemoteProject {
    private readonly api: BaseAPI;
    private identity!: Identity;
    private socket!: SocketIOAPI;
    private project!: ProjectEntity;
    private readonly entries = new Map<string, RemoteEntry>();
    private readonly idToPath = new Map<string, string>();
    private readonly collaboratorNames = new Map<string,string>();
    private changeHandler?: (change:RemoteChange) => void;
    private reconnectHandler?: () => void;
    private readonly externalTransport?:RemoteProjectTransport;

    constructor(
        private readonly url:string,
        private readonly projectId:string,
        private readonly cookies:string,
        transport?:RemoteProjectTransport,
    ) {
        this.externalTransport = transport;
        this.api = transport?.api ?? new BaseAPI(url);
    }

    async connect(): Promise<void> {
        if (this.externalTransport) {
            this.identity = this.externalTransport.identity;
            this.socket = this.externalTransport.socket;
        } else {
            const login = await this.api.cookiesLogin(this.cookies);
            if (login.type!=='success' || !login.identity) {
                throw new Error(login.message || `Authentication to ${this.url} failed.`);
            }
            this.identity = login.identity;
            this.socket = new SocketIOAPI(this.url, this.api, this.identity, this.projectId);
        }
        this.project = await this.socket.joinProject(this.projectId);
        this.indexCollaborators();
        this.reindex();
        this.registerEvents();
    }

    disconnect() {
        if (!this.externalTransport) { this.socket?.disconnect(); }
    }

    onChange(handler: (change:RemoteChange) => void) {
        this.changeHandler = handler;
        return () => {
            if (this.changeHandler===handler) { this.changeHandler = undefined; }
        };
    }

    onReconnect(handler:() => void) {
        this.reconnectHandler = handler;
        return () => {
            if (this.reconnectHandler===handler) { this.reconnectHandler = undefined; }
        };
    }

    listEntries(): RemoteEntry[] {
        return [...this.entries.values()];
    }

    entry(path: string): RemoteEntry | undefined {
        return this.entries.get(normalizePath(path));
    }

    async read(path: string): Promise<Uint8Array> {
        const entry = this.requireEntry(path);
        if (entry.type==='doc') {
            const result = await this.socket.joinDoc(entry.entity._id);
            return new TextEncoder().encode(result.docLines.join('\n'));
        }
        if (entry.type==='file') {
            const result = await this.api.getFile(this.identity, this.projectId, entry.entity._id);
            if (result.type==='success' && result.content) { return result.content; }
            throw new Error(`Could not download ${path}.`);
        }
        throw new Error(`${path} is not a file.`);
    }

    async mkdir(path: string): Promise<void> {
        const normalized = normalizePath(path);
        if (this.entries.has(normalized)) { return; }
        const {parent, name} = await this.ensureParent(normalized);
        const result = await this.api.addFolder(this.identity, this.projectId, name, parent._id);
        if (result.type!=='success' || !result.entity) {
            throw new Error(result.message || `Could not create ${normalized}.`);
        }
        const folder = result.entity as FolderEntity;
        folder._type = 'folder';
        folder.docs ??= [];
        folder.fileRefs ??= [];
        folder.folders ??= [];
        parent.folders.push(folder);
        this.reindex();
    }

    async write(path: string, content: Uint8Array): Promise<void> {
        const normalized = normalizePath(path);
        const existing = this.entries.get(normalized);
        if (existing?.type==='folder') {
            throw new Error(`${normalized} is a directory.`);
        }
        if (existing?.type==='doc') {
            await this.writeDocument(existing.entity as DocumentEntity, content);
            return;
        }
        if (existing) {
            await this.remove(normalized);
        }
        const {parent, name} = await this.ensureParent(normalized);
        const text = textContent(content);
        if (text!==undefined) {
            const created = await this.api.addDoc(this.identity, this.projectId, parent._id, name);
            if (created.type!=='success' || !created.entity) {
                throw new Error(created.message || `Could not create ${normalized}.`);
            }
            const entity = created.entity as DocumentEntity;
            entity._type = 'doc';
            parent.docs.push(entity);
            this.reindex();
            if (content.length!==0) { await this.writeDocument(entity, content); }
            return;
        }
        const uploaded = await this.api.uploadFile(this.identity, this.projectId, parent._id, name, content);
        if (uploaded.type!=='success' || !uploaded.entity) {
            throw new Error(uploaded.message || `Could not upload ${normalized}.`);
        }
        const entity = uploaded.entity as FileRefEntity;
        entity._type = 'file';
        parent.fileRefs.push(entity);
        this.reindex();
    }

    async remove(path: string): Promise<void> {
        const normalized = normalizePath(path);
        const entry = this.requireEntry(normalized);
        if (!entry.parent) { throw new Error('The project root cannot be removed.'); }
        const result = await this.api.deleteEntity(this.identity, this.projectId, entry.type, entry.entity._id);
        if (result.type!=='success') {
            throw new Error(result.message || `Could not remove ${normalized}.`);
        }
        this.removeFromParent(entry);
        this.reindex();
    }

    async getCurrentVersion(): Promise<number> {
        const response = await this.api.proxyToHistoryApiAndGetUpdates(this.identity, this.projectId);
        const version = response.updates?.updates.at(0)?.toV ?? 0;
        if (response.type!=='success' || !Number.isInteger(version)) {
            throw new Error(response.message || 'Could not determine the current Overleaf project version.');
        }
        return version;
    }

    async getFileTreeDiff(from:number, to:number): Promise<ProjectFileTreeDiffResponseSchema | undefined> {
        if (from>=to) { return {diff:[]}; }
        const response = await this.api.proxyToHistoryApiAndGetFileTreeDiff(
            this.identity, this.projectId, from, to,
        );
        if (response.type==='success') { return response.treeDiff; }
        if (response.statusCode===404) { return undefined; }
        throw new Error(response.message || 'Could not load the Overleaf file-tree history.');
    }

    private async writeDocument(entity: DocumentEntity, content: Uint8Array): Promise<void> {
        const text = textContent(content);
        if (text===undefined) {
            const path = this.idToPath.get(entity._id)!;
            await this.remove(path);
            await this.write(path, content);
            return;
        }
        const remote = await this.socket.joinDoc(entity._id);
        const previous = remote.docLines.join('\n');
        if (previous===text) { return; }
        let position = 0;
        const operations:NonNullable<UpdateSchema['op']> = [];
        for (const part of new DiffMatchPatch().diff_main(previous, text)) {
            const start = position;
            if (part[0]!==-1) { position += part[1].length; }
            if (part[0]===1) { operations.push({p:start, i:part[1]}); }
            if (part[0]===-1) { operations.push({p:start, d:part[1]}); }
        }
        const update: UpdateSchema = {
            doc:entity._id,
            v:remote.version,
            hash:createHash('sha1').update(`blob ${text.length}\x00${text}`).digest('hex'),
            op:operations,
        };
        await this.socket.applyOtUpdate(entity._id, update);
    }

    private async ensureParent(path: string): Promise<{parent:FolderEntity; name:string}> {
        const name = posix.basename(path);
        const parentPath = posix.dirname(path);
        if (parentPath!=='/' && !this.entries.has(parentPath)) {
            await this.mkdir(parentPath);
        }
        const parentEntry = parentPath==='/' ? this.entries.get('/') : this.entries.get(parentPath);
        if (!parentEntry || parentEntry.type!=='folder') {
            throw new Error(`Parent directory ${parentPath} does not exist.`);
        }
        return {parent:parentEntry.entity as FolderEntity, name};
    }

    private requireEntry(path: string): RemoteEntry {
        const normalized = normalizePath(path);
        const entry = this.entries.get(normalized);
        if (!entry) { throw new Error(`Remote path not found: ${normalized}`); }
        return entry;
    }

    private reindex() {
        this.entries.clear();
        this.idToPath.clear();
        const root = this.project.rootFolder[0];
        root._type = 'folder';
        this.indexFolder(root, '/');
    }

    private indexFolder(folder: FolderEntity, path: string, parent?:FolderEntity) {
        this.entries.set(path, {path, type:'folder', entity:folder, parent});
        this.idToPath.set(folder._id, path);
        for (const child of folder.folders ?? []) {
            child._type = 'folder';
            this.indexFolder(child, normalizePath(posix.join(path, child.name)), folder);
        }
        for (const child of folder.docs ?? []) {
            child._type = 'doc';
            const childPath = normalizePath(posix.join(path, child.name));
            this.entries.set(childPath, {path:childPath, type:'doc', entity:child, parent:folder});
            this.idToPath.set(child._id, childPath);
        }
        for (const child of folder.fileRefs ?? []) {
            child._type = 'file';
            const childPath = normalizePath(posix.join(path, child.name));
            this.entries.set(childPath, {path:childPath, type:'file', entity:child, parent:folder});
            this.idToPath.set(child._id, childPath);
        }
    }

    private folderById(id:string): FolderEntity | undefined {
        const path = this.idToPath.get(id);
        const entry = path ? this.entries.get(path) : undefined;
        return entry?.type==='folder' ? entry.entity as FolderEntity : undefined;
    }

    private removeFromParent(entry: RemoteEntry) {
        if (!entry.parent) { return; }
        const collection = entry.type==='folder'
            ? entry.parent.folders
            : entry.type==='doc' ? entry.parent.docs : entry.parent.fileRefs;
        const index = collection.findIndex(item => item._id===entry.entity._id);
        if (index!==-1) { collection.splice(index, 1); }
    }

    private emitChange(path:string, previousPath?:string, actor?:string) {
        this.changeHandler?.({path:normalizePath(path), previousPath, actor});
    }

    private indexCollaborators() {
        for (const member of [this.project.owner, ...this.project.members]) {
            if (!member?._id) { continue; }
            const name = [member.first_name, member.last_name].filter(Boolean).join(' ').trim();
            if (name) { this.collaboratorNames.set(member._id, name); }
        }
    }

    private actor(userId:string|undefined):string|undefined {
        if (!userId) { return undefined; }
        const name = this.collaboratorNames.get(userId);
        return name ? `${name} (Overleaf)` : `Overleaf user ${userId}`;
    }

    private registerEvents() {
        this.socket.updateEventHandlers({
            onProjectJoined:project => {
                this.project = project;
                this.indexCollaborators();
                this.reindex();
                this.reconnectHandler?.();
            },
            onClientUpdated:user => {
                if (user.user_id && user.name) { this.collaboratorNames.set(user.user_id, user.name); }
            },
            onFileCreated:(parentId, type, entity) => {
                const parent = this.folderById(parentId);
                if (!parent || type==='outputs') { return; }
                if (this.idToPath.has(entity._id)) { return; }
                entity._type = type;
                if (type==='folder') {
                    const folder = entity as FolderEntity;
                    folder.docs ??= [];
                    folder.fileRefs ??= [];
                    folder.folders ??= [];
                    parent.folders.push(folder);
                } else if (type==='doc') {
                    parent.docs.push(entity as DocumentEntity);
                } else {
                    parent.fileRefs.push(entity as FileRefEntity);
                }
                const parentPath = this.idToPath.get(parentId) ?? '/';
                this.reindex();
                this.emitChange(posix.join(parentPath, entity.name));
            },
            onFileRenamed:(entityId, newName) => {
                const previousPath = this.idToPath.get(entityId);
                if (!previousPath) { return; }
                this.entries.get(previousPath)!.entity.name = newName;
                this.reindex();
                this.emitChange(this.idToPath.get(entityId)!, previousPath);
            },
            onFileRemoved:(entityId) => {
                const previousPath = this.idToPath.get(entityId);
                if (!previousPath) { return; }
                const entry = this.entries.get(previousPath)!;
                this.removeFromParent(entry);
                this.reindex();
                this.emitChange(previousPath);
            },
            onFileMoved:(entityId, parentId) => {
                const previousPath = this.idToPath.get(entityId);
                const nextParent = this.folderById(parentId);
                if (!previousPath || !nextParent) { return; }
                const entry = this.entries.get(previousPath)!;
                this.removeFromParent(entry);
                if (entry.type==='folder') { nextParent.folders.push(entry.entity as FolderEntity); }
                else if (entry.type==='doc') { nextParent.docs.push(entry.entity as DocumentEntity); }
                else { nextParent.fileRefs.push(entry.entity as FileRefEntity); }
                this.reindex();
                this.emitChange(this.idToPath.get(entityId)!, previousPath);
            },
            onFileChanged:update => {
                const path = this.idToPath.get(update.doc);
                if (path) { this.emitChange(path, undefined, this.actor(update.meta?.user_id)); }
            },
        });
    }
}
