import {createHash} from 'node:crypto';
import {homedir} from 'node:os';
import {join, resolve} from 'node:path';

export interface DaemonPaths {
    home:string;
    socketPath:string;
    metadataPath:string;
    logPath:string;
    startupLockPath:string;
}

export function daemonPaths(environment:NodeJS.ProcessEnv=process.env):DaemonPaths {
    const home = environment.LEAFRELAY_HOME ? resolve(environment.LEAFRELAY_HOME) : join(homedir(), '.leafrelay');
    const socketPath = process.platform==='win32'
        ? `\\\\.\\pipe\\leafrelay-${createHash('sha256').update(home).digest('hex').slice(0, 16)}`
        : join(home, 'daemon.sock');
    return {
        home,
        socketPath,
        metadataPath:join(home, 'daemon.json'),
        logPath:join(home, 'daemon.log'),
        startupLockPath:join(home, 'daemon.starting'),
    };
}
