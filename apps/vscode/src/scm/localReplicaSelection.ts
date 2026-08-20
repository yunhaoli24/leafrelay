export interface LocalReplicaCandidate<T> {
    baseUri: string;
    value: T;
}

export function partitionLocalReplicas<T>(
    candidates: LocalReplicaCandidate<T>[],
    activeWorkspaceUri?: string,
) {
    return candidates.reduce<{active: LocalReplicaCandidate<T>[], inactive: LocalReplicaCandidate<T>[]}>(
        (result, candidate) => {
            result[activeWorkspaceUri!==undefined && candidate.baseUri===activeWorkspaceUri ? 'active' : 'inactive'].push(candidate);
            return result;
        },
        {active: [], inactive: []},
    );
}
