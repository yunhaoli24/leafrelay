import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LeafRelayDaemonClient } from '../src/client';
import { daemonPaths } from '../src/paths';
import { LeafRelayDaemonServer } from '../src/server';
import { NetworkRuntimeRegistry } from '../src/networkRuntime';
import { log } from '@leafrelay/core';

const homes: string[] = [];

afterEach(async () => {
    await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe('LeafRelay daemon IPC', () => {
    it('forwards connection diagnostics and string rejections through RPC', async () => {
        const home = await mkdtemp(join(tmpdir(), 'leafrelay-errors-'));
        homes.push(home);
        const environment = { ...process.env, LEAFRELAY_HOME: home };
        const server = new LeafRelayDaemonServer({ paths: daemonPaths(environment), exitOnIdle: false });
        await server.start();
        const client = await LeafRelayDaemonClient.connect({
            clientName: 'test',
            clientVersion: 'test',
            environment,
            autoStart: false,
        });
        const messages: string[] = [];
        client.onLog((event) => messages.push(event.message));
        const call = vi.spyOn(NetworkRuntimeRegistry.prototype, 'callProject').mockRejectedValueOnce('timeout');
        try {
            log('SocketIOAPI: connect_failed', {
                error: new Error('fetch failed', { cause: new Error('ECONNRESET') }),
            });
            await expect(client.callProject('project', 'joinProject')).rejects.toThrow('timeout');
            await vi.waitFor(() => expect(messages.some((message) => message.includes('ECONNRESET'))).toBe(true));
        } finally {
            call.mockRestore();
            client.close();
            await server.stop();
        }
    });

    it('shares one daemon between concurrent clients and validates the protocol', async () => {
        const home = await mkdtemp(join(tmpdir(), 'leafrelay-daemon-'));
        homes.push(home);
        const environment = { ...process.env, LEAFRELAY_HOME: home };
        const server = new LeafRelayDaemonServer({ paths: daemonPaths(environment), exitOnIdle: false });
        const metadata = await server.start();

        const [first, second] = await Promise.all([
            LeafRelayDaemonClient.connect({ clientName: 'test', clientVersion: 'test', environment, autoStart: false }),
            LeafRelayDaemonClient.connect({ clientName: 'test', clientVersion: 'test', environment, autoStart: false }),
        ]);
        const status = await first.status();
        expect(status.pid).toBe(metadata.pid);
        expect(status.protocolVersion).toBe(1);
        expect(status.clients).toBe(2);

        first.close();
        second.close();
        await server.stop();
    });

    it('elects one detached daemon when clients start concurrently', async () => {
        const home = await mkdtemp(join(tmpdir(), 'leafrelay-election-'));
        homes.push(home);
        const environment = { ...process.env, LEAFRELAY_HOME: home };
        const daemonEntrypoint = new URL('../dist/daemon.js', import.meta.url);
        const [first, second] = await Promise.all([
            LeafRelayDaemonClient.connect({ clientName: 'test', clientVersion: 'test', environment, daemonEntrypoint }),
            LeafRelayDaemonClient.connect({ clientName: 'test', clientVersion: 'test', environment, daemonEntrypoint }),
        ]);

        expect(first.initializeResult.pid).toBe(second.initializeResult.pid);
        expect((await first.status()).clients).toBe(2);
        expect(await first.listServers()).toEqual([
            {
                name: 'www.overleaf.com',
                url: 'https://www.overleaf.com/',
                loggedIn: false,
            },
        ]);
        await first.addServer('Community', 'http://localhost:8080');
        expect(await second.listServers()).toContainEqual({
            name: 'Community',
            url: 'http://localhost:8080/',
            loggedIn: false,
        });
        second.close();
        await first.shutdownDaemon();
        first.close();
    });

    it.skipIf(process.platform === 'win32')(
        'restarts a crashed daemon and reconnects the existing client',
        async () => {
            const home = await mkdtemp(join(tmpdir(), 'leafrelay-reconnect-'));
            homes.push(home);
            const environment = { ...process.env, LEAFRELAY_HOME: home };
            const client = await LeafRelayDaemonClient.connect({
                clientName: 'test',
                clientVersion: 'test',
                environment,
                daemonEntrypoint: new URL('../dist/daemon.js', import.meta.url),
            });
            const previousPid = (await client.status()).pid;
            process.kill(previousPid, 'SIGTERM');

            const deadline = Date.now() + 7000;
            let currentPid = previousPid;
            while (Date.now() < deadline && currentPid === previousPid) {
                try {
                    currentPid = (await client.status()).pid;
                } catch {}
                if (currentPid === previousPid) {
                    await new Promise((resolve) => setTimeout(resolve, 50));
                }
            }
            expect(currentPid).not.toBe(previousPid);
            await client.shutdownDaemon();
            client.close();
        },
        10_000,
    );
});
