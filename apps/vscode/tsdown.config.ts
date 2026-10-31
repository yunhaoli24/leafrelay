import { readFile } from 'node:fs/promises';
import { defineConfig } from 'tsdown';

const packageJson = JSON.parse(await readFile(new URL('package.json', import.meta.url), 'utf8'));
export default defineConfig({
    entry: { extension: 'src/extension.ts', daemon: '../../packages/daemon/src/main.ts' },
    format: 'esm',
    fixedExtension: false,
    platform: 'node' as const,
    target: 'node24',
    sourcemap: true,
    outDir: 'out',
    dts: false,
    clean: true,
    shims: true,
    deps: { alwaysBundle: [/.*/], neverBundle: ['vscode'] },
    define: { LEAFRELAY_DAEMON_VERSION: JSON.stringify(packageJson.version) },
});
