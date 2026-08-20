import {mkdir, readFile, writeFile, chmod} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import type {Identity} from '../api/base';

export interface ServerSession {
    url: string;
    userId: string;
    userEmail: string;
    identity: Identity;
    updatedAt: string;
}

export interface LeafRelayConfig {
    version: 1;
    servers: Record<string, ServerSession>;
    knownServers?:Record<string,{name:string; url:string}>;
}

export function configPath(environment: NodeJS.ProcessEnv = process.env): string {
    return environment.LEAFRELAY_CONFIG
        ? resolve(environment.LEAFRELAY_CONFIG)
        : join(environment.LEAFRELAY_HOME ? resolve(environment.LEAFRELAY_HOME) : join(homedir(), '.leafrelay'), 'config.json');
}

export function normalizeServerUrl(value: string): string {
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    url.pathname = '/';
    url.search = '';
    url.hash = '';
    return url.href;
}

export function serverKey(value: string): string {
    return new URL(normalizeServerUrl(value)).host;
}

export async function readConfig(path = configPath()): Promise<LeafRelayConfig> {
    try {
        const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<LeafRelayConfig>;
        if (parsed.version!==1 || typeof parsed.servers!=='object' || parsed.servers===null) {
            throw new Error(`Unsupported LeafRelay configuration in ${path}`);
        }
        return parsed as LeafRelayConfig;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code==='ENOENT') {
            return {version:1, servers:{}, knownServers:{}};
        }
        throw error;
    }
}

export async function writeConfig(config: LeafRelayConfig, path = configPath()): Promise<void> {
    await mkdir(dirname(path), {recursive:true, mode:0o700});
    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, {encoding:'utf8', mode:0o600});
    await chmod(path, 0o600);
}

export async function saveServerSession(session: ServerSession, path = configPath()): Promise<void> {
    const config = await readConfig(path);
    const key = serverKey(session.url);
    config.servers[key] = session;
    config.knownServers ??= {};
    config.knownServers[key] ??= {name:key, url:session.url};
    await writeConfig(config, path);
}

export async function saveKnownServer(name:string, url:string, path=configPath()):Promise<void> {
    const config = await readConfig(path);
    const key = serverKey(url);
    config.knownServers ??= {};
    config.knownServers[key] = {name, url:normalizeServerUrl(url)};
    await writeConfig(config, path);
}

export async function removeKnownServer(server:string, path=configPath()):Promise<void> {
    const config = await readConfig(path);
    const key = serverKey(server);
    delete config.servers[key];
    delete config.knownServers?.[key];
    await writeConfig(config, path);
}

export async function removeServerSession(server:string, path=configPath()):Promise<void> {
    const config = await readConfig(path);
    delete config.servers[serverKey(server)];
    await writeConfig(config, path);
}

export async function getServerSession(
    server: string,
    environment: NodeJS.ProcessEnv = process.env,
    path = configPath(environment),
): Promise<ServerSession | undefined> {
    const key = serverKey(server);
    const config = await readConfig(path);
    const stored = config.servers[key];
    const cookie = environment.LEAFRELAY_COOKIE;
    if (!cookie) { return stored; }
    return {
        url: stored?.url ?? normalizeServerUrl(server),
        userId: stored?.userId ?? '',
        userEmail: stored?.userEmail ?? '',
        identity: {cookies:cookie, csrfToken:stored?.identity.csrfToken ?? ''},
        updatedAt: stored?.updatedAt ?? new Date(0).toISOString(),
    };
}
