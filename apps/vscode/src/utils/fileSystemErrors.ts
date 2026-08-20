export function isMissingFileSystemError(error: unknown): boolean {
    if (typeof error !== 'object' || error===null) { return false; }
    const code = (error as {code?: unknown}).code;
    return code === 'FileNotFound' || code === 'EntryNotFound';
}
