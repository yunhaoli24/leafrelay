import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {LeafRelayDaemonClient} from '../src/client';
import {daemonPaths} from '../src/paths';
import {LeafRelayDaemonServer} from '../src/server';

const homes:string[] = [];

afterEach(async () => {
    await Promise.all(homes.splice(0).map(home => rm(home, {recursive:true, force:true})));
});

describe('LeafRelay daemon IPC', () => {
    it('shares one daemon between concurrent clients and validates the protocol', async () => {
        const home = await mkdtemp(join(tmpdir(), 'leafrelay-daemon-'));
        homes.push(home);
        const environment = {...process.env, LEAFRELAY_HOME:home};
        const server = new LeafRelayDaemonServer({paths:daemonPaths(environment), exitOnIdle:false});
        const metadata = await server.start();

        const [first, second] = await Promise.all([
            LeafRelayDaemonClient.connect({clientName:'test', clientVersion:'test', environment, autoStart:false}),
            LeafRelayDaemonClient.connect({clientName:'test', clientVersion:'test', environment, autoStart:false}),
        ]);
        const status = await first.status();
        expect(status.pid).toBe(metadata.pid);
        expect(status.protocolVersion).toBe(1);
        expect(status.clients).toBe(2);

        first.close();
        second.close();
        await server.stop();
    });
});
