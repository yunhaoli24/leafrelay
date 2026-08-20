import {randomUUID} from 'node:crypto';
import {realpath} from 'node:fs/promises';
import {resolve} from 'node:path';
import {readProjectSettings, startServe, type RunningServe} from '@leafrelay/core';
import type {
    ReplicaAttachParams,
    ReplicaAttachResult,
    ReplicaConflictNotification,
    ReplicaStatus,
    ReplicaStatusNotification,
} from '@leafrelay/protocol';

const DETACHED_REPLICA_GRACE_MS = 60_000;

interface ReplicaEntry {
    id:string;
    root:string;
    projectKey:string;
    serverName:string;
    projectId:string;
    projectName:string;
    owners:Set<string>;
    running:RunningServe;
    status:ReplicaStatus;
    stopTimer?:NodeJS.Timeout;
}

type ReplicaStarter = (directory:string, options:NonNullable<Parameters<typeof startServe>[1]>) => Promise<RunningServe>;

export class ReplicaAlreadyActiveError extends Error {
    readonly code = 'ReplicaAlreadyActive';

    constructor(readonly projectId:string, readonly activeRoot:string, readonly requestedRoot:string) {
        super(`Overleaf project ${projectId} is already synchronized by ${activeRoot}; ${requestedRoot} cannot become a second writable replica.`);
    }
}

export interface ReplicaRegistryEvents {
    status:(owners:ReadonlySet<string>, notification:ReplicaStatusNotification) => void;
    conflict:(owners:ReadonlySet<string>, notification:ReplicaConflictNotification) => void;
    empty:() => void;
    log:(message:string) => void;
}

export class ReplicaRegistry {
    private readonly byId = new Map<string,ReplicaEntry>();
    private readonly byRoot = new Map<string,ReplicaEntry>();
    private readonly byProject = new Map<string,ReplicaEntry>();
    private readonly projectOperations = new Map<string,Promise<void>>();

    constructor(
        private readonly events:ReplicaRegistryEvents,
        private readonly start:ReplicaStarter=startServe,
    ) {}

    get size():number { return this.byId.size; }

    async attach(clientId:string, params:ReplicaAttachParams):Promise<ReplicaAttachResult> {
        const root = await realpath(resolve(params.directory));
        const settings = await readProjectSettings(root);
        const projectKey = `${settings.serverName}\0${settings.projectId}`;
        return this.withProjectLock(projectKey, () => this.attachResolved(clientId, params, root, settings, projectKey));
    }

    private async attachResolved(
        clientId:string,
        params:ReplicaAttachParams,
        root:string,
        settings:Awaited<ReturnType<typeof readProjectSettings>>,
        projectKey:string,
    ):Promise<ReplicaAttachResult> {
        const rootEntry = this.byRoot.get(root);
        if (rootEntry) {
            if (rootEntry.projectKey!==projectKey) {
                throw new Error(`${root} is already registered for another Overleaf project.`);
            }
            this.addOwner(rootEntry, clientId);
            return this.result(rootEntry, true);
        }
        const projectEntry = this.byProject.get(projectKey);
        if (projectEntry) {
            throw new ReplicaAlreadyActiveError(settings.projectId, projectEntry.root, root);
        }

        const id = randomUUID();
        const owners = new Set([clientId]);
        const status:ReplicaStatus = {state:'starting'};
        let entry:ReplicaEntry|undefined;
        this.events.status(owners, {replicaId:id, status});
        try {
            const running = await this.start(root, {
                cookie:params.cookie,
                log:message => this.events.log(`[${settings.projectName}] ${message}`),
                onConflict:(path, reason) => {
                    if (!entry) { return; }
                    entry.status = {state:'paused', message:`Conflict in ${path}`};
                    this.events.conflict(entry.owners, {
                        replicaId:entry.id,
                        path,
                        reason,
                        conflicts:entry.running.conflicts(),
                    });
                    this.events.status(entry.owners, {replicaId:entry.id, status:entry.status});
                },
            });
            entry = {
                id,
                root,
                projectKey,
                serverName:settings.serverName,
                projectId:settings.projectId,
                projectName:settings.projectName,
                owners,
                running,
                status:running.conflicts().length===0 ? {state:'active'} : {state:'paused'},
            };
            this.byId.set(id, entry);
            this.byRoot.set(root, entry);
            this.byProject.set(projectKey, entry);
            this.events.status(owners, {replicaId:id, status:entry.status});
            return this.result(entry, false);
        } catch (error) {
            const failed:ReplicaStatus = {state:'error', message:error instanceof Error ? error.message : String(error)};
            this.events.status(owners, {replicaId:id, status:failed});
            throw error;
        }
    }

    detach(clientId:string, replicaId:string):void {
        const entry = this.require(replicaId);
        entry.owners.delete(clientId);
        this.scheduleStopWhenDetached(entry);
    }

    detachClient(clientId:string):void {
        for (const entry of this.byId.values()) {
            if (entry.owners.delete(clientId)) { this.scheduleStopWhenDetached(entry); }
        }
    }

    async resolveConflict(replicaId:string, path:string, winner:'local'|'remote'):Promise<void> {
        const entry = this.require(replicaId);
        await entry.running.resolveConflict(path, winner);
        entry.status = entry.running.conflicts().length===0 ? {state:'active'} : {state:'paused'};
        this.events.status(entry.owners, {replicaId, status:entry.status});
    }

    async retry(replicaId:string, path:string):Promise<void> {
        const entry = this.require(replicaId);
        await entry.running.retry(path);
        entry.status = entry.running.conflicts().length===0 ? {state:'active'} : {state:'paused'};
        this.events.status(entry.owners, {replicaId, status:entry.status});
    }

    list() {
        return [...this.byId.values()].map(entry => ({
            id:entry.id,
            root:entry.root,
            serverName:entry.serverName,
            projectId:entry.projectId,
            projectName:entry.projectName,
            clients:entry.owners.size,
            status:entry.status,
            conflicts:entry.running.conflicts(),
        }));
    }

    async stopAll():Promise<void> {
        await Promise.all([...this.byId.values()].map(entry => this.stop(entry)));
    }

    private addOwner(entry:ReplicaEntry, clientId:string):void {
        if (entry.stopTimer) { clearTimeout(entry.stopTimer); entry.stopTimer = undefined; }
        entry.owners.add(clientId);
    }

    private scheduleStopWhenDetached(entry:ReplicaEntry):void {
        if (entry.owners.size!==0 || entry.stopTimer) { return; }
        entry.stopTimer = setTimeout(() => void this.stop(entry), DETACHED_REPLICA_GRACE_MS);
        entry.stopTimer.unref();
    }

    private async stop(entry:ReplicaEntry):Promise<void> {
        if (!this.byId.delete(entry.id)) { return; }
        if (entry.stopTimer) { clearTimeout(entry.stopTimer); }
        this.byRoot.delete(entry.root);
        this.byProject.delete(entry.projectKey);
        entry.status = {state:'stopping'};
        this.events.status(entry.owners, {replicaId:entry.id, status:entry.status});
        await entry.running.stop();
        this.events.empty();
    }

    private require(replicaId:string):ReplicaEntry {
        const entry = this.byId.get(replicaId);
        if (!entry) { throw new Error(`Unknown replica ${replicaId}.`); }
        return entry;
    }

    private result(entry:ReplicaEntry, shared:boolean):ReplicaAttachResult {
        return {
            replicaId:entry.id,
            root:entry.root,
            serverName:entry.serverName,
            projectId:entry.projectId,
            projectName:entry.projectName,
            shared,
            status:entry.status,
            conflicts:entry.running.conflicts(),
        };
    }

    private async withProjectLock<T>(projectKey:string, operation:() => Promise<T>):Promise<T> {
        const previous = this.projectOperations.get(projectKey) ?? Promise.resolve();
        let release!:() => void;
        const current = new Promise<void>(resolveOperation => { release = resolveOperation; });
        this.projectOperations.set(projectKey, current);
        await previous;
        try {
            return await operation();
        } finally {
            release();
            if (this.projectOperations.get(projectKey)===current) { this.projectOperations.delete(projectKey); }
        }
    }
}
