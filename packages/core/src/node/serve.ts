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
    stop():Promise<void>;
}

export async function startServe(directory=process.cwd()):Promise<RunningServe> {
    const root = resolve(directory);
    const settings = await readProjectSettings(root);
    const session = await getServerSession(settings.serverName);
    if (!session) {
        throw new Error(`No login is stored for ${settings.serverName}. Run: leafrelay login ${settings.serverName}`);
    }
    const cookie = process.env.LEAFRELAY_COOKIE || session.identity.cookies;
    const remote = new RemoteProject(session.url || settings.serverUrl, settings.projectId, cookie);
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
        log,
        onConflict:(path, reason) => {
            log(`Conflict paused for ${path}: ${reason}`);
        },
    });
    try {
        await engine.start();
    } catch (error) {
        remote.disconnect();
        throw error;
    }
    log(`LeafRelay is serving ${root} (${settings.projectName}).`);
    return {
        stop:async () => {
            await engine.stop();
            remote.disconnect();
        },
    };
}
