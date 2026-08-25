import {createHash} from 'node:crypto';
import {encodeTextBase} from './threeWayMerge';

export const SYNC_STATE_SCHEMA_VERSION = 1;

export interface LocalReplicaSyncState {
    schemaVersion: number;
    projectUri: string;
    remoteVersion: number;
    initialized: boolean;
    files: {[path:string]: string};
    textBases: {[path:string]: string};
    conflicts: {[path:string]: string};
}

export function sha256(content: Uint8Array): string {
    return createHash('sha256').update(content).digest('hex');
}

export function createSyncState(
    projectUri: string,
    remoteVersion: number,
    initialized = true,
): LocalReplicaSyncState {
    return {
        schemaVersion:SYNC_STATE_SCHEMA_VERSION,
        projectUri,
        remoteVersion,
        initialized,
        files:{},
        textBases:{},
        conflicts:{},
    };
}

export function updateSyncCheckpoint(state: LocalReplicaSyncState, path: string, content: Uint8Array) {
    state.files[path] = sha256(content);
    const textBase = encodeTextBase(content);
    if (textBase===undefined) {
        delete state.textBases[path];
    } else {
        state.textBases[path] = textBase;
    }
}

export function removeSyncCheckpoint(state: LocalReplicaSyncState, path: string) {
    const checkpointPaths = new Set([...Object.keys(state.files), ...Object.keys(state.conflicts)]);
    for (const checkpointPath of checkpointPaths) {
        if (checkpointPath===path || checkpointPath.startsWith(`${path}/`)) {
            delete state.files[checkpointPath];
            delete state.textBases[checkpointPath];
            delete state.conflicts[checkpointPath];
        }
    }
}

export function readTextBase(state: LocalReplicaSyncState | undefined, path: string): Uint8Array | undefined {
    const textBase = state?.textBases[path];
    return textBase===undefined ? undefined : new TextEncoder().encode(textBase);
}
