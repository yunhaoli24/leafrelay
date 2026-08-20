import {mkdtemp, readFile, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {getServerSession, readConfig, saveServerSession} from '../src/node/config';

const temporaryDirectories:string[] = [];

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, {recursive:true, force:true})));
});

describe('LeafRelay user configuration', () => {
    it('stores a server session in the selected config file with private permissions', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'leafrelay-config-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'config.json');
        await saveServerSession({
            url:'https://www.overleaf.com/',
            userId:'user-1',
            userEmail:'user@example.com',
            identity:{cookies:'session=stored', csrfToken:'csrf'},
            updatedAt:'2026-08-20T00:00:00.000Z',
        }, path);

        expect((await readConfig(path)).servers['www.overleaf.com'].userId).toBe('user-1');
        expect((await stat(path)).mode & 0o777).toBe(0o600);
        expect(JSON.parse(await readFile(path, 'utf8')).version).toBe(1);
    });

    it('uses LEAFRELAY_COOKIE without replacing the stored session', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'leafrelay-config-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'config.json');
        await saveServerSession({
            url:'https://www.overleaf.com/',
            userId:'user-1',
            userEmail:'user@example.com',
            identity:{cookies:'session=stored', csrfToken:'csrf'},
            updatedAt:'2026-08-20T00:00:00.000Z',
        }, path);

        const session = await getServerSession('www.overleaf.com', {
            LEAFRELAY_CONFIG:path,
            LEAFRELAY_COOKIE:'session=environment',
        });
        expect(session?.identity.cookies).toBe('session=environment');
        expect((await readConfig(path)).servers['www.overleaf.com'].identity.cookies).toBe('session=stored');
    });
});
