import {readFile} from 'node:fs/promises';
import {defineConfig} from 'tsup';

const packageJson = JSON.parse(await readFile(new URL('package.json', import.meta.url), 'utf8'));

export default defineConfig({
    entry:{index:'src/index.ts', daemon:'src/main.ts'},
    format:['esm'],
    platform:'node',
    target:'node24',
    sourcemap:true,
    dts:{entry:{index:'src/index.ts'}},
    clean:true,
    noExternal:['@leafrelay/core', '@leafrelay/protocol'],
    external:['vscode-jsonrpc'],
    define:{LEAFRELAY_DAEMON_VERSION:JSON.stringify(packageJson.version)},
});
