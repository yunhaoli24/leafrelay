import {resolve} from 'node:path';
import {log} from '../core/logger';
import {createIgnoreMatcher} from '../sync/ignore';
import {RemoteProject} from '../sync/remoteProject';
import {SyncEngine} from '../sync/syncEngine';
import {getServerSession} from './config';
import {NodeReplicaFileSystem} from './localFileSystem';
import {readProjectSettings} from './projectSettings';
import {FileSyncStateStore} from './syncStateStore';

export interface RunningServe {
    readonly root:string;
    readonly serverName:string;
    readonly projectId:string;
    readonly projectName:string;
    conflicts():string[];
    resolveConflict(path:string, winner:'local'|'remote'):Promise<void>;
    retry(path:string):Promise<void>;
    stop():Promise<void>;
}

export interface StartServeOptions {
    cookie?:string;
    log?:(message:string) => void;
    onConflict?:(path:string, reason:string) => void;
    remote?:RemoteProject;
}

export async function startServe(directory=process.cwd(), options:StartServeOptions={}):Promise<RunningServe> {
    const root = resolve(directory);
    const settings = await readProjectSettings(root);
    const session = await getServerSession(settings.serverName);
    if (!session) {
        throw new Error(`No login is stored for ${settings.serverName}. Run: leafrelay login ${settings.serverName}`);
    }
    const cookie = options.cookie || process.env.LEAFRELAY_COOKIE || session.identity.cookies;
    const remote = options.remote ?? new RemoteProject(session.url || settings.serverUrl, settings.projectId, cookie);
    await remote.connect();

    const configuredPatterns = settings.localReplica.settings['ignore-patterns'];
    const ignore = createIgnoreMatcher(configuredPatterns);
    const local = new NodeReplicaFileSystem(root, ignore);
    const engine = new SyncEngine({
        projectUri:settings.uri,
        local,
        remote,
        stateStore:new FileSyncStateStore(root, settings.uri),
        ignore,
        log:options.log ?? log,
        onConflict:options.onConflict ?? ((path, reason) => {
            (options.log ?? log)(`Conflict paused for ${path}: ${reason}`);
        }),
    });
    try {
        await engine.start();
    } catch (error) {
        remote.disconnect();
        throw error;
    }
    (options.log ?? log)(`LeafRelay is serving ${root} (${settings.projectName}).`);
    return {
        root,
        serverName:settings.serverName,
        projectId:settings.projectId,
        projectName:settings.projectName,
        conflicts:() => engine.getConflicts(),
        resolveConflict:(path, winner) => engine.resolveConflict(path, winner),
        retry:path => engine.retry(path),
        stop:async () => {
            await engine.stop();
            remote.disconnect();
        },
    };
}
