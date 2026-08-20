import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import * as vscode from 'vscode';

suite('LeafRelay activation', () => {
    test('registers the Add Server command', async () => {
        const extension = vscode.extensions.getExtension('yunhaoli24.leafrelay');
        assert.ok(extension, 'LeafRelay extension is available to the Extension Host');

        await extension.activate();
        assert.equal(extension.isActive, true, 'LeafRelay activates without a module-load error');

        const commands = await vscode.commands.getCommands(true);
        assert.ok(
            commands.includes('leafrelay.projectManager.addServer'),
            'the Add Server command is registered after activation',
        );

        const daemonHome = process.env.LEAFRELAY_HOME ?? join(homedir(), '.leafrelay');
        const metadata = JSON.parse(await readFile(join(daemonHome, 'daemon.json'), 'utf8'));
        assert.equal(metadata.protocolVersion, 1, 'the extension activates through the shared daemon protocol');
        assert.ok(metadata.pid>0, 'the shared daemon is running');
    });
});
