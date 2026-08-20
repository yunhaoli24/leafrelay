import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
    files: 'apps/vscode/test/extension/**/*.test.mjs',
    extensionDevelopmentPath: 'apps/vscode',
    version: 'stable',
    launchArgs: [
        '--disable-extensions',
        '--disable-gpu',
        '--no-sandbox',
        '--skip-release-notes',
        '--skip-welcome',
    ],
    mocha: {
        ui: 'tdd',
        timeout: 20000,
    },
});
