import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const outputRoot = join(process.cwd(), 'out', 'socket-runtime', 'node_modules');
const copied = new Set();

function copyPackage(name, searchPaths = [process.cwd()]) {
    if (copied.has(name)) {
        return;
    }

    const packagePath = require.resolve(`${name}/package.json`, { paths: searchPaths });
    const packageRoot = dirname(packagePath);
    const destination = join(outputRoot, name);
    const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));

    copied.add(name);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(packageRoot, destination, { recursive: true });

    for (const dependency of Object.keys(packageJson.dependencies ?? {})) {
        copyPackage(dependency, [packageRoot]);
    }
}

rmSync(dirname(outputRoot), { recursive: true, force: true });
copyPackage('socket.io-client');
