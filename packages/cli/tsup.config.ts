import {readFile} from 'node:fs/promises';
import {defineConfig} from 'tsup';

const packageJson = JSON.parse(await readFile(new URL('package.json', import.meta.url), 'utf8'));

export default defineConfig({
    entry:{cli:'src/cli.ts', index:'src/index.ts'},
    format:['esm'],
    platform:'node',
    target:'node24',
    sourcemap:true,
    dts:{resolve:['@leafrelay/core']},
    clean:true,
    noExternal:['@leafrelay/core'],
    define:{LEAFRELAY_VERSION:JSON.stringify(packageJson.version)},
});
