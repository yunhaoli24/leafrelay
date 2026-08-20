import {readFile} from 'node:fs/promises';
import {build, context} from 'esbuild';

const packageJson = JSON.parse(await readFile(new URL('package.json', import.meta.url), 'utf8'));
const watch = process.argv.includes('--watch');
const common = {
    bundle:true,
    platform:'node',
    target:'node24',
    sourcemap:true,
    logLevel:'info',
};
const configurations = [
    {
        ...common,
        entryPoints:['src/extension.ts'],
        format:'esm',
        external:['vscode'],
        outfile:'out/extension.js',
        banner:{js:"import {createRequire as __leafrelayCreateRequire} from 'node:module';const require=__leafrelayCreateRequire(import.meta.url);"},
    },
    {
        ...common,
        entryPoints:['../../packages/daemon/src/main.ts'],
        format:'cjs',
        outfile:'out/daemon.cjs',
        define:{LEAFRELAY_DAEMON_VERSION:JSON.stringify(packageJson.version)},
    },
];

if (watch) {
    const contexts = await Promise.all(configurations.map(configuration => context(configuration)));
    await Promise.all(contexts.map(buildContext => buildContext.watch()));
} else {
    await Promise.all(configurations.map(configuration => build(configuration)));
}
