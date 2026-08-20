import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {parseSyncState, type LocalReplicaSyncState} from '../sync/checkpoint';
import type {SyncStateStore} from '../sync/syncEngine';

export class FileSyncStateStore implements SyncStateStore {
    private readonly path:string;
    private serialized?:string;

    constructor(directory:string, private readonly projectUri:string) {
        this.path = resolve(directory, '.overleaf', 'sync-state.json');
    }

    async load():Promise<LocalReplicaSyncState|undefined> {
        try {
            const content = await readFile(this.path, 'utf8');
            const state = parseSyncState(content, this.projectUri);
            if (state) { this.serialized = `${JSON.stringify(state, null, 2)}\n`; }
            return state;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code==='ENOENT') { return undefined; }
            throw error;
        }
    }

    async save(state:LocalReplicaSyncState):Promise<void> {
        const serialized = `${JSON.stringify(state, null, 2)}\n`;
        if (serialized===this.serialized) { return; }
        await mkdir(dirname(this.path), {recursive:true});
        await writeFile(this.path, serialized, 'utf8');
        this.serialized = serialized;
    }
}
