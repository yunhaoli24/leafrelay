import { describe, expect, it } from 'vitest';
import { partitionLocalReplicas } from '../src/scm/localReplicaSelection';

describe('partitionLocalReplicas', () => {
    it('activates only the replica matching the current workspace', () => {
        const candidates = [
            {baseUri:'file:///workspace/current', value:'current'},
            {baseUri:'file:///workspace/other', value:'other'},
        ];

        expect(partitionLocalReplicas(candidates, 'file:///workspace/current')).toEqual({
            active: [candidates[0]],
            inactive: [candidates[1]],
        });
    });

    it('does not fall back to another replica when the workspace has no match', () => {
        const candidates = [
            {baseUri:'file:///workspace/other', value:'other'},
        ];

        expect(partitionLocalReplicas(candidates, 'file:///workspace/current')).toEqual({
            active: [],
            inactive: candidates,
        });
    });

    it('keeps every replica inactive outside a single local-folder workspace', () => {
        const candidates = [
            {baseUri:'file:///workspace/one', value:'one'},
            {baseUri:'file:///workspace/two', value:'two'},
        ];

        expect(partitionLocalReplicas(candidates)).toEqual({
            active: [],
            inactive: candidates,
        });
    });
});
