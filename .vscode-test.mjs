import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
    files: 'test/extension/**/*.test.mjs',
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
