import { EnvHttpProxyAgent, ProxyAgent, Socks5ProxyAgent, type Dispatcher } from 'undici';

export interface NetworkDispatcherOptions {
    environment?: NodeJS.ProcessEnv;
    proxy?: string;
}

function firstEnvironmentValue(environment: NodeJS.ProcessEnv, ...names: string[]): string | undefined {
    return names
        .map((name) => environment[name])
        .find((value) => value?.trim() !== undefined)
        ?.trim();
}

function createExplicitProxy(proxy: string): Dispatcher {
    const normalized = proxy.toLowerCase();
    if (normalized.startsWith('socks5://') || normalized.startsWith('socks5h://')) {
        return new Socks5ProxyAgent(proxy);
    }
    return new ProxyAgent(proxy);
}

/**
 * Creates the dispatcher shared by Overleaf HTTP and WebSocket traffic.
 *
 * `LEAFRELAY_PROXY=direct` explicitly bypasses all environment proxies. An
 * explicit value can be an HTTP(S) or SOCKS5 proxy. Otherwise standard
 * HTTP_PROXY/HTTPS_PROXY/NO_PROXY variables are used, including their lower
 * case forms. ALL_PROXY is used when no protocol-specific proxy is present.
 */
export function createNetworkDispatcher(options: NetworkDispatcherOptions = {}): Dispatcher | undefined {
    const environment = options.environment ?? process.env;
    const configured = options.proxy ?? environment.LEAFRELAY_PROXY;
    if (configured?.toLowerCase() === 'direct') {
        return undefined;
    }
    if (configured) {
        return createExplicitProxy(configured);
    }

    const httpProxy = firstEnvironmentValue(environment, 'HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy');
    const httpsProxy = firstEnvironmentValue(environment, 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy');
    const noProxy = firstEnvironmentValue(environment, 'NO_PROXY', 'no_proxy');
    if (httpProxy || httpsProxy) {
        return new EnvHttpProxyAgent({ httpProxy, httpsProxy, noProxy });
    }

    const allProxy = firstEnvironmentValue(environment, 'ALL_PROXY', 'all_proxy');
    return allProxy ? createExplicitProxy(allProxy) : undefined;
}

export function describeNetworkDispatcher(environment: NodeJS.ProcessEnv = process.env): string {
    const configured = environment.LEAFRELAY_PROXY?.trim();
    if (configured?.toLowerCase() === 'direct') {
        return 'direct (LEAFRELAY_PROXY)';
    }
    if (configured) {
        return configured.toLowerCase().startsWith('socks5')
            ? 'SOCKS5 proxy (LEAFRELAY_PROXY)'
            : 'HTTP proxy (LEAFRELAY_PROXY)';
    }
    if (
        firstEnvironmentValue(environment, 'HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy') ||
        firstEnvironmentValue(environment, 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy')
    ) {
        return 'environment HTTP(S) proxy';
    }
    if (firstEnvironmentValue(environment, 'ALL_PROXY', 'all_proxy')) {
        return 'environment ALL_PROXY';
    }
    return 'direct';
}

let defaultDispatcher: Dispatcher | undefined;
let defaultDispatcherEnvironmentKey: string | undefined;

function environmentKey(environment: NodeJS.ProcessEnv): string {
    return [
        environment.LEAFRELAY_PROXY,
        environment.HTTP_PROXY,
        environment.http_proxy,
        environment.HTTPS_PROXY,
        environment.https_proxy,
        environment.NO_PROXY,
        environment.no_proxy,
        environment.ALL_PROXY,
        environment.all_proxy,
    ]
        .map((value) => value ?? '')
        .join('\u0000');
}

export function getDefaultNetworkDispatcher(environment: NodeJS.ProcessEnv = process.env): Dispatcher | undefined {
    const key = environmentKey(environment);
    if (defaultDispatcherEnvironmentKey !== key) {
        void defaultDispatcher?.close?.();
        defaultDispatcher = createNetworkDispatcher({ environment });
        defaultDispatcherEnvironmentKey = key;
    }
    return defaultDispatcher;
}
