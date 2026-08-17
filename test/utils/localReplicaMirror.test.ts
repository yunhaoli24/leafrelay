import { describe, expect, it } from 'vitest';
import { createLocalToRemoteMirrorPlan } from '../../src/scm/localReplicaMirror';

describe('createLocalToRemoteMirrorPlan', () => {
    it('mirrors local entries and removes remote-only paths', () => {
        expect(createLocalToRemoteMirrorPlan(
            [
                {path:'/chapters', type:'directory'},
                {path:'/chapters/one.tex', type:'file'},
                {path:'/main.tex', type:'file'},
            ],
            [
                {path:'/old', type:'directory'},
                {path:'/old/note.tex', type:'file'},
                {path:'/main.tex', type:'file'},
            ],
        )).toEqual({
            deleteRemote: ['/old'],
            createDirectories: ['/chapters'],
            writeFiles: ['/chapters/one.tex', '/main.tex'],
        });
    });

    it('replaces paths whose types differ without duplicating child deletions', () => {
        expect(createLocalToRemoteMirrorPlan(
            [
                {path:'/assets', type:'file'},
                {path:'/empty', type:'directory'},
            ],
            [
                {path:'/assets', type:'directory'},
                {path:'/assets/old.png', type:'file'},
                {path:'/empty', type:'file'},
            ],
        )).toEqual({
            deleteRemote: ['/assets', '/empty'],
            createDirectories: ['/empty'],
            writeFiles: ['/assets'],
        });
    });
});
