import {lstat, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {dirname, relative, resolve, sep} from 'node:path';
import {watch, type FSWatcher} from 'chokidar';
import type {ReplicaFileSystem} from '../sync/syncEngine';

function projectPath(root:string, path:string):string {
    const target = resolve(root, path.replace(/^\/+/, ''));
    const relativePath = relative(root, target);
    if (relativePath.startsWith('..') || relativePath=== '..') {
        throw new Error(`Path escapes the local project: ${path}`);
    }
    return target;
}

function syncPath(root:string, path:string):string {
    return `/${relative(root, path).split(sep).join('/')}`;
}

export class NodeReplicaFileSystem implements ReplicaFileSystem {
    private watcher?:FSWatcher;

    constructor(
        private readonly root:string,
        private readonly ignore:(path:string)=>boolean,
    ) {}

    async listFiles():Promise<string[]> {
        const files:string[] = [];
        const visit = async (directory:string) => {
            for (const entry of await readdir(directory, {withFileTypes:true})) {
                const absolute = resolve(directory, entry.name);
                const path = syncPath(this.root, absolute);
                if (this.ignore(path) || entry.name.startsWith('.') || entry.isSymbolicLink()) { continue; }
                if (entry.isDirectory()) { await visit(absolute); }
                else if (entry.isFile()) { files.push(path); }
            }
        };
        await visit(this.root);
        return files.sort();
    }

    async read(path:string):Promise<Uint8Array|undefined> {
        const target = projectPath(this.root, path);
        try {
            const stat = await lstat(target);
            if (!stat.isFile() || stat.isSymbolicLink()) { return undefined; }
            return new Uint8Array(await readFile(target));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code==='ENOENT') { return undefined; }
            throw error;
        }
    }

    async write(path:string, content:Uint8Array):Promise<void> {
        const target = projectPath(this.root, path);
        await mkdir(dirname(target), {recursive:true});
        await writeFile(target, content);
    }

    async remove(path:string):Promise<void> {
        await rm(projectPath(this.root, path), {force:true, recursive:true});
    }

    async watch(onChange:(path:string)=>void):Promise<() => Promise<void>> {
        this.watcher = watch(this.root, {
            ignoreInitial:true,
            followSymlinks:false,
            ignored:path => {
                const relativePath = relative(this.root, path);
                if (!relativePath) { return false; }
                const normalized = `/${relativePath.split(sep).join('/')}`;
                return this.ignore(normalized) || normalized.split('/').some(part => part.startsWith('.'));
            },
            awaitWriteFinish:{stabilityThreshold:200, pollInterval:50},
        });
        const handler = (path:string) => onChange(syncPath(this.root, path));
        this.watcher.on('add', handler).on('change', handler).on('unlink', handler);
        await new Promise<void>((resolveReady, reject) => {
            this.watcher!.once('ready', resolveReady).once('error', reject);
        });
        return async () => { await this.watcher?.close(); };
    }
}
