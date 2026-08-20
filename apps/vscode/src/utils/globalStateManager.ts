import * as vscode from 'vscode';
import { Identity, BaseAPI, ProjectPersist } from '@leafrelay/core';
import type {LeafRelayDaemonClient} from '@leafrelay/daemon';
import {createDaemonApi, DaemonProjectSocket} from '../api/daemonAdapters';
import {DaemonService} from './daemonService';
import {warn} from './outputChannel';

const keyServerPersists: string = 'overleaf-servers';
const keyPdfViewPersists: string = 'overleaf-pdf-viewers';

export interface ServerPersist {
    name: string;
    url: string;
    login?: {
        userId: string;
        username: string;
        identity: Identity;
        projects?: ProjectPersist[]
    };
}
type ServerPersistMap = {[name: string]: ServerPersist};

export interface ProjectSCMPersist {
    enabled: boolean;
    label: string;
    baseUri: string;
    settings: JSON;
}
type ProjectSCMPersistMap = {[name: string]: ProjectSCMPersist};

type PdfViewPersist = {
    frequency: number,
    state: any,
};
type PdfViewPersistMap = {[uri: string]: PdfViewPersist};

export class GlobalStateManager {
    private static daemon:LeafRelayDaemonClient;

    static async initialize(context:vscode.ExtensionContext):Promise<void> {
        this.daemon = DaemonService.current;
        const persists = context.globalState.get<ServerPersistMap>(keyServerPersists, {});
        let descriptors = await this.daemon.listServers();
        const byName = new Map(descriptors.map(server => [server.name, server]));

        for (const persist of Object.values(persists)) {
            if (!byName.has(persist.name)) {
                await this.daemon.addServer(persist.name, persist.url);
            }
            const descriptor = byName.get(persist.name);
            if (persist.login?.identity.cookies && !descriptor?.loggedIn) {
                try {
                    const imported = await this.daemon.importSession({
                        name:persist.name,
                        url:persist.url,
                        userId:persist.login.userId,
                        userEmail:persist.login.username,
                        identity:persist.login.identity,
                    });
                    persist.login.userId = imported.userId;
                    persist.login.username = imported.userEmail || persist.login.username;
                    persist.login.identity = {cookies:'', csrfToken:''};
                } catch (error) {
                    warn(`Could not import the previous ${persist.name} login: ${error instanceof Error ? error.message : String(error)}`);
                    delete persist.login;
                }
            } else if (descriptor?.loggedIn && persist.login) {
                persist.login.identity = {cookies:'', csrfToken:''};
            }
        }

        descriptors = await this.daemon.listServers();
        for (const descriptor of descriptors) {
            const persist = persists[descriptor.name] ?? {name:descriptor.name, url:descriptor.url};
            persist.url = descriptor.url;
            if (descriptor.loggedIn) {
                persist.login = {
                    userId:descriptor.userId ?? persist.login?.userId ?? '',
                    username:descriptor.userEmail ?? persist.login?.username ?? '',
                    identity:{cookies:'', csrfToken:''},
                    projects:persist.login?.projects,
                };
            } else {
                delete persist.login;
            }
            persists[descriptor.name] = persist;
        }
        await context.globalState.update(keyServerPersists, persists);
    }

    static getServers(context:vscode.ExtensionContext): {server:ServerPersist, api:BaseAPI}[] {
        const persists = context.globalState.get<ServerPersistMap>(keyServerPersists, {});
        const servers = Object.values(persists).map(persist => {
            return {
                server: persist,
                api:createDaemonApi(this.daemon, persist.name, persist.url),
            };
        });

        if (servers.length===0) {
            const url = new URL('https://www.overleaf.com');
            persists[url.host] = {name:url.host, url:url.href};
            void context.globalState.update(keyServerPersists, persists);
            void this.daemon.addServer(url.host, url.href);
            return this.getServers(context);
        } else {
            return servers;
        }
    }

    static async addServer(context:vscode.ExtensionContext, name:string, url:string): Promise<boolean> {
        const persists = context.globalState.get<ServerPersistMap>(keyServerPersists, {});
        if ( persists[name]===undefined ) {
            persists[name] = { name, url };
            await this.daemon.addServer(name, url);
            await context.globalState.update(keyServerPersists, persists);
            return true;
        } else {
            return false;
        }
    }

    static async removeServer(context:vscode.ExtensionContext, name:string): Promise<boolean> {
        const persists = context.globalState.get<ServerPersistMap>(keyServerPersists, {});
        if ( persists[name]!==undefined ) {
            const url = persists[name].url;
            delete persists[name];
            await this.daemon.removeServer(url);
            await context.globalState.update(keyServerPersists, persists);
            return true;
        } else {
            return false;
        }
    }

    static async loginServer(context:vscode.ExtensionContext, _api:BaseAPI, name:string, auth:{[key:string]:string}): Promise<boolean> {
        const persists = context.globalState.get<ServerPersistMap>(keyServerPersists, {});
        const server   = persists[name];

        if (server.login===undefined) {
            try {
                const user = await this.daemon.login({server:server.url, cookie:auth.cookies, email:auth.email, password:auth.password});
                server.login = {
                    userId:user.userId,
                    username:auth.email || user.userEmail,
                    identity:{cookies:'', csrfToken:''},
                };
                await context.globalState.update(keyServerPersists, persists);
                return true;
            } catch (error) {
                vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
                return false;
            }
        } else {
            return false;
        }
    }

    static async logoutServer(context:vscode.ExtensionContext, _api:BaseAPI, name:string): Promise<boolean> {
        const persists = context.globalState.get<ServerPersistMap>(keyServerPersists, {});
        const server   = persists[name];

        if (server.login!==undefined) {
            await this.daemon.logout(server.url);
            delete server.login;
            context.globalState.update(keyServerPersists, persists);
            return true;
        } else {
            return false;
        }
    }

    static async fetchServerProjects(context:vscode.ExtensionContext, api:BaseAPI, name:string): Promise<ProjectPersist[]> {
        const persists = context.globalState.get<ServerPersistMap>(keyServerPersists, {});
        const server   = persists[name];

        if (server.login!==undefined) {
            let res = await api.getProjectsJson(server.login.identity);
            if (res.type!=='success') {
                // fallback to `userProjectsJson`
                res = await api.userProjectsJson(server.login.identity);
            }
            if (res.type==='success' && res.projects!==undefined) {
                Object.values(res.projects).forEach(project => {
                    project.userId = (server.login as any).userId;
                });
                const projects = res.projects.map(project => {
                    const existProject = server.login?.projects?.find(p => p.id===project.id);
                    // merge existing scm
                    if (existProject) {
                        project.scm = existProject.scm;
                    }
                    return project;
                });
                server.login.projects = projects;
                context.globalState.update(keyServerPersists, persists);
                return projects;
            } else {
                // regex match for cookie expired
                const cookieExpireRegex = /^302/;
                if (res.message && cookieExpireRegex.test(res.message)) {
                    vscode.window.showErrorMessage(vscode.l10n.t('Cookie Expired. Please Re-Login'));
                    return Promise.reject();
                }
                if (res.message!==undefined) {
                    vscode.window.showErrorMessage(res.message);
                }
                return [];
            }
        } else {
            return [];
        }
    }

    static authenticate(context:vscode.ExtensionContext, name:string) {
        const persists = context.globalState.get<ServerPersistMap>(keyServerPersists, {});
        const server   = persists[name];
        return server.login!==undefined ?
                Promise.resolve(server.login.identity):
                Promise.reject();
    }

    static initSocketIOAPI(context:vscode.ExtensionContext, name:string, projectId:string) {
        const persists = context.globalState.get<ServerPersistMap>(keyServerPersists, {});
        const server   = persists[name];

        if (server.login!==undefined) {
            const api = createDaemonApi(this.daemon, name, server.url);
            const socket = new DaemonProjectSocket(this.daemon, server.url, projectId);
            return {api, socket};
        }
    }

    static getServerProjectSCMPersists(context:vscode.ExtensionContext, serverName:string, projectId:string) {
        const persists = context.globalState.get<ServerPersistMap>(keyServerPersists, {});
        const server   = persists[serverName];
        const project  = server.login?.projects?.find(project => project.id===projectId);
        const scmPersists = project?.scm ? project.scm as ProjectSCMPersistMap : {};
        return scmPersists;
    }

    static updateServerProjectSCMPersist(context:vscode.ExtensionContext, serverName:string, projectId:string, scmKey:string, scmPersist?:ProjectSCMPersist) {
        const persists = context.globalState.get<ServerPersistMap>(keyServerPersists, {});
        const server   = persists[serverName];
        const project  = server.login?.projects?.find(project => project.id===projectId);
        if (project) {
            const scmPersists = (project.scm ?? {}) as ProjectSCMPersistMap;
            if (scmPersist===undefined) {
                delete scmPersists[scmKey];
            } else {
                scmPersists[scmKey] = scmPersist;
            }
            project.scm = scmPersists;
            context.globalState.update(keyServerPersists, persists);
        }
    }

    /**
     * Recreates the in-memory project entry needed by SCMCollectionProvider
     * from a local replica's .overleaf/settings.json after a re-login.
     */
    static async restoreLocalReplicaSCM(
        context:vscode.ExtensionContext,
        serverName:string,
        projectId:string,
        projectName:string,
        userId:string|undefined,
        scmKey:string,
        scmPersist:ProjectSCMPersist,
    ): Promise<boolean> {
        const persists = context.globalState.get<ServerPersistMap>(keyServerPersists, {});
        const server = persists[serverName];
        if (server?.login===undefined) { return false; }
        server.login.projects ??= [];
        let project = server.login.projects.find(item => item.id===projectId);
        if (project===undefined) {
            project = {
                id: projectId,
                userId: userId || server.login.userId,
                name: projectName,
                source: 'owner',
                accessLevel: 'owner',
                scm: {},
            };
            server.login.projects.push(project);
        }
        const scmPersists = (project.scm ?? {}) as ProjectSCMPersistMap;
        scmPersists[scmKey] = scmPersist;
        project.scm = scmPersists;
        await context.globalState.update(keyServerPersists, persists);
        return true;
    }

    static getPdfViewPersist(context:vscode.ExtensionContext, uri:string): any {
        return context.globalState.get<PdfViewPersistMap>(keyPdfViewPersists, {})[uri]?.state;
    }

    static updatePdfViewPersist(context:vscode.ExtensionContext, uri:string, state:any) {
        const persists = context.globalState.get<PdfViewPersistMap>(keyPdfViewPersists, {});

        // update record
        if (persists[uri]!==undefined) {
            persists[uri].frequency++;
            persists[uri].state = state;
        } else {
            persists[uri] = {frequency: 1, state};
        }

        // when length>=100, remove first least used record
        if (Object.keys(persists).length>=100) {
            let minFrequency = Number.MAX_SAFE_INTEGER;
            let minUri = '';
            Object.entries(persists).forEach(([uri, persist]) => {
                if (persist.frequency<minFrequency) {
                    minFrequency = persist.frequency;
                    minUri = uri;
                }
            });
            delete persists[minUri];
        }

        context.globalState.update(keyPdfViewPersists, persists);
    }

}
