import {describe, expect, it} from 'vitest';
import {isCurrentCollaborator} from '../src/collaboration/collaboratorIdentity';

describe('collaborator identity', () => {
    it('recognizes the current connection and other connections from the same account', () => {
        expect(isCurrentCollaborator('client-1', 'user-1', 'client-1', 'user-1')).toBe(true);
        expect(isCurrentCollaborator('browser-client', 'user-1', 'vscode-client', 'user-1')).toBe(true);
    });

    it('keeps other accounts visible and does not equate missing account IDs', () => {
        expect(isCurrentCollaborator('client-2', 'user-2', 'client-1', 'user-1')).toBe(false);
        expect(isCurrentCollaborator('client-2', undefined, 'client-1', undefined)).toBe(false);
    });
});
