export function isCurrentCollaborator(
    clientId:string,
    userId:string | undefined,
    currentClientId:string,
    currentUserId:string | undefined,
):boolean {
    if (clientId===currentClientId) { return true; }
    return Boolean(currentUserId && userId===currentUserId);
}
