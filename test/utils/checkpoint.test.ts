import {describe, expect, it} from 'vitest';
import {
    createSyncState,
    parseSyncState,
    readTextBase,
    removeSyncCheckpoint,
    sha256,
    updateSyncCheckpoint,
} from '../../src/sync/checkpoint';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe('sync checkpoint', () => {
    it('migrates version 1 hash-only state without invalidating it', () => {
        const state = parseSyncState(JSON.stringify({
            schemaVersion:1,
            projectUri:'overleaf://project',
            remoteVersion:42,
            files:{'/main.tex':'hash'},
        }), 'overleaf://project');

        expect(state).toEqual({
            schemaVersion:2,
            projectUri:'overleaf://project',
            remoteVersion:42,
            files:{'/main.tex':'hash'},
            textBases:{},
        });
    });

    it('stores a text merge base alongside the content fingerprint', () => {
        const state = createSyncState('overleaf://project', 7);
        const content = encoder.encode('shared text\n');

        updateSyncCheckpoint(state, '/main.tex', content);

        expect(state.files['/main.tex']).toBe(sha256(content));
        expect(decoder.decode(readTextBase(state, '/main.tex'))).toBe('shared text\n');
    });

    it('keeps only a fingerprint for binary files', () => {
        const state = createSyncState('overleaf://project', 7);
        const content = new Uint8Array([0, 1, 2]);

        updateSyncCheckpoint(state, '/figure.pdf', content);

        expect(state.files['/figure.pdf']).toBe(sha256(content));
        expect(readTextBase(state, '/figure.pdf')).toBeUndefined();
    });

    it('removes a path and all descendant checkpoints', () => {
        const state = createSyncState('overleaf://project', 7);
        updateSyncCheckpoint(state, '/section/main.tex', encoder.encode('main'));
        updateSyncCheckpoint(state, '/section/notes.tex', encoder.encode('notes'));
        updateSyncCheckpoint(state, '/other.tex', encoder.encode('other'));

        removeSyncCheckpoint(state, '/section');

        expect(state.files).toEqual({'/other.tex':sha256(encoder.encode('other'))});
        expect(state.textBases).toEqual({'/other.tex':'other'});
    });
});
