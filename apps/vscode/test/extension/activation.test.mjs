import assert from 'node:assert/strict';
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
    });
});
