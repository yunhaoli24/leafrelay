import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';

export interface LocalProjectSettings {
    uri: string;
    serverName: string;
    serverUrl: string;
    projectId: string;
    projectName: string;
    userId?: string;
    localReplica: {
        settings: Record<string, unknown>;
    };
}

function parseProjectUri(value: string) {
    const uri = new URL(value);
    const decodedQuery = decodeURIComponent(uri.search.slice(1));
    const query = new URLSearchParams(decodedQuery);
    const projectId = query.get('project');
    if (!projectId) {
        throw new Error('The project URI in .overleaf/settings.json does not contain a project ID.');
    }
    return {
        serverName:uri.host,
        projectId,
        projectName:decodeURIComponent(uri.pathname.split('/').filter(Boolean)[0] ?? ''),
        userId:query.get('user') ?? undefined,
    };
}

export async function readProjectSettings(directory: string): Promise<LocalProjectSettings> {
    const settingsPath = resolve(directory, '.overleaf', 'settings.json');
    const raw = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>;
    if (typeof raw.uri!=='string') {
        throw new Error(`${settingsPath} does not contain a valid project URI.`);
    }
    const parsed = parseProjectUri(raw.uri);
    const serverName = typeof raw.serverName==='string' ? raw.serverName : parsed.serverName;
    const localReplica = raw.localReplica as {settings?:Record<string, unknown>} | undefined;
    return {
        uri:raw.uri,
        serverName,
        serverUrl:typeof raw.serverUrl==='string' ? raw.serverUrl : `https://${serverName}/`,
        projectId:parsed.projectId,
        projectName:typeof raw.projectName==='string' ? raw.projectName : parsed.projectName,
        userId:parsed.userId,
        localReplica:{settings:localReplica?.settings ?? {}},
    };
}
