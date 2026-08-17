export type ReplicaEntryType = 'file' | 'directory';

export interface ReplicaEntry {
    path: string;
    type: ReplicaEntryType;
}

export interface LocalToRemoteMirrorPlan {
    deleteRemote: string[];
    createDirectories: string[];
    writeFiles: string[];
}

function pathDepth(path: string): number {
    return path.split('/').filter(Boolean).length;
}

export function createLocalToRemoteMirrorPlan(
    localEntries: ReplicaEntry[],
    remoteEntries: ReplicaEntry[],
): LocalToRemoteMirrorPlan {
    const localByPath = new Map(localEntries.map(entry => [entry.path, entry.type]));
    const remoteByPath = new Map(remoteEntries.map(entry => [entry.path, entry.type]));
    const deletionCandidates = remoteEntries
        .filter(entry => localByPath.get(entry.path)!==entry.type)
        .map(entry => entry.path)
        .sort((a, b) => pathDepth(a)-pathDepth(b) || a.localeCompare(b));
    const deleteRemote = deletionCandidates.filter((path, index, paths) =>
        !paths.slice(0, index).some(parent => path.startsWith(`${parent}/`))
    );
    const createDirectories = localEntries
        .filter(entry => entry.type==='directory' && remoteByPath.get(entry.path)!=='directory')
        .map(entry => entry.path)
        .sort((a, b) => pathDepth(a)-pathDepth(b) || a.localeCompare(b));
    const writeFiles = localEntries
        .filter(entry => entry.type==='file')
        .map(entry => entry.path)
        .sort((a, b) => a.localeCompare(b));

    return {deleteRemote, createDirectories, writeFiles};
}
