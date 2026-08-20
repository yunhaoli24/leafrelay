import {readFile} from 'node:fs/promises';
import {defineConfig} from 'tsup';

const packageJson = JSON.parse(await readFile(new URL('package.json', import.meta.url), 'utf8'));

export default defineConfig({
    entry:{cli:'src/cli.ts', index:'src/index.ts', daemon:'../daemon/src/main.ts'},
    format:['esm'],
    platform:'node',
    target:'node24',
    sourcemap:true,
    dts:{entry:{index:'src/index.ts'}, resolve:['@leafrelay/core', '@leafrelay/daemon', '@leafrelay/protocol']},
    clean:true,
    noExternal:['@leafrelay/core', '@leafrelay/daemon', '@leafrelay/protocol'],
    external:['vscode-jsonrpc'],
    define:{
        LEAFRELAY_VERSION:JSON.stringify(packageJson.version),
        LEAFRELAY_DAEMON_VERSION:JSON.stringify(packageJson.version),
    },
});
