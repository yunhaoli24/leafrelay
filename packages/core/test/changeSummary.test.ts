import {describe, expect, it} from 'vitest';
import {describeContentChange} from '../src/sync/changeSummary';

const bytes = (value:string) => new TextEncoder().encode(value);

describe('describeContentChange', () => {
    it('reports compact line ranges for separate text edits', () => {
        expect(describeContentChange(
            bytes('one\ntwo\nthree\nfour\nfive\n'),
            bytes('ONE\ntwo\nthree\nFOUR\nfive\n'),
        )).toBe('lines 1, 4');
    });

    it('reports additions, removals, and binary byte counts', () => {
        expect(describeContentChange(undefined, bytes('one\ntwo\n'))).toBe('added lines 1-2');
        expect(describeContentChange(bytes('one\ntwo\n'), undefined)).toBe('removed lines 1-2');
        expect(describeContentChange(new Uint8Array([0, 1]), new Uint8Array([0, 1, 2])))
            .toBe('binary bytes 2 -> 3');
    });
});
