import { readFile } from 'node:fs/promises';
import { defineConfig } from 'tsdown';

const packageJson = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));

export default defineConfig({
    entry: { index: 'src/index.ts', daemon: 'src/main.ts' },
    format: ['esm'],
    fixedExtension: false,
    platform: 'node',
    target: 'node24',
    sourcemap: true,
    dts: true,
    clean: true,
    deps: { alwaysBundle: [/^@leafrelay\//], neverBundle: ['vscode-jsonrpc'] },
    define: { LEAFRELAY_DAEMON_VERSION: JSON.stringify(packageJson.version) },
});
