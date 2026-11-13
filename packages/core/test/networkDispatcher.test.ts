import { describe, expect, it } from 'vitest';
import { createNetworkDispatcher } from '../src/api/networkDispatcher';

async function closeDispatcher(dispatcher: ReturnType<typeof createNetworkDispatcher>) {
    await dispatcher?.close?.();
}

describe('network dispatcher', () => {
    it('uses an explicit HTTP proxy for both HTTP and WebSocket callers', async () => {
        const dispatcher = createNetworkDispatcher({
            environment: {},
            proxy: 'http://127.0.0.1:7890',
        });

        expect(dispatcher?.constructor.name).toBe('ProxyAgent');
        await closeDispatcher(dispatcher);
    });

    it('supports SOCKS5 proxies and an explicit direct mode', async () => {
        const socks = createNetworkDispatcher({
            environment: {},
            proxy: 'socks5://127.0.0.1:7891',
        });
        expect(socks?.constructor.name).toBe('Socks5ProxyAgent');
        await closeDispatcher(socks);

        expect(createNetworkDispatcher({ environment: {}, proxy: 'direct' })).toBeUndefined();
    });

    it('honors standard proxy variables and NO_PROXY', async () => {
        const dispatcher = createNetworkDispatcher({
            environment: {
                HTTP_PROXY: 'http://127.0.0.1:7890',
                HTTPS_PROXY: 'http://127.0.0.1:7890',
                NO_PROXY: 'localhost,.internal.test',
            },
        });

        expect(dispatcher?.constructor.name).toBe('EnvHttpProxyAgent');
        await closeDispatcher(dispatcher);
    });
});
