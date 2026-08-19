import {createHash} from 'node:crypto';
import {encodeTextBase} from './threeWayMerge';

export const SYNC_STATE_SCHEMA_VERSION = 2;

export interface LocalReplicaSyncState {
    schemaVersion: number;
    projectUri: string;
    remoteVersion: number;
    files: {[path:string]: string};
    textBases: {[path:string]: string};
}

export function sha256(content: Uint8Array): string {
    return createHash('sha256').update(content).digest('hex');
}

export function parseSyncState(serialized: string, projectUri: string): LocalReplicaSyncState | undefined {
    try {
        const state = JSON.parse(serialized) as LocalReplicaSyncState;
        if ((state.schemaVersion!==1 && state.schemaVersion!==SYNC_STATE_SCHEMA_VERSION) ||
            state.projectUri!==projectUri ||
            !Number.isInteger(state.remoteVersion) ||
            typeof state.files!=='object' || state.files===null) {
            return undefined;
        }
        return {
            ...state,
            schemaVersion:SYNC_STATE_SCHEMA_VERSION,
            textBases:typeof state.textBases==='object' && state.textBases!==null ? state.textBases : {},
        };
    } catch {
        return undefined;
    }
}

export function createSyncState(projectUri: string, remoteVersion: number): LocalReplicaSyncState {
    return {
        schemaVersion:SYNC_STATE_SCHEMA_VERSION,
        projectUri,
        remoteVersion,
        files:{},
        textBases:{},
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
    for (const checkpointPath of Object.keys(state.files)) {
        if (checkpointPath===path || checkpointPath.startsWith(`${path}/`)) {
            delete state.files[checkpointPath];
            delete state.textBases[checkpointPath];
        }
    }
}

export function readTextBase(state: LocalReplicaSyncState | undefined, path: string): Uint8Array | undefined {
    const textBase = state?.textBases[path];
    return textBase===undefined ? undefined : new TextEncoder().encode(textBase);
}
