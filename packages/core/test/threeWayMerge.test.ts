import {describe, expect, it} from 'vitest';
import {encodeTextBase, mergeText} from '../src/sync/threeWayMerge';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const bytes = (content: string) => encoder.encode(content);

describe('mergeText', () => {
    it('merges changes in different paragraphs', () => {
        const result = mergeText(
            bytes('first paragraph\n\nsecond paragraph\n'),
            bytes('first paragraph edited locally\n\nsecond paragraph\n'),
            bytes('first paragraph\n\nsecond paragraph edited remotely\n'),
        );

        expect(result.status).toBe('merged');
        expect(decoder.decode(result.content)).toBe(
            'first paragraph edited locally\n\nsecond paragraph edited remotely\n',
        );
    });

    it('reports overlapping line edits as a conflict', () => {
        const result = mergeText(
            bytes('shared line\n'),
            bytes('local line\n'),
            bytes('remote line\n'),
        );

        expect(result).toEqual({status:'conflict'});
    });

    it('accepts an identical edit made on both sides', () => {
        const result = mergeText(
            bytes('before\n'),
            bytes('after\n'),
            bytes('after\n'),
        );

        expect(result.status).toBe('merged');
        expect(decoder.decode(result.content)).toBe('after\n');
    });

    it('preserves CRLF and a missing final newline', () => {
        const result = mergeText(
            bytes('one\r\nunchanged\r\ntwo'),
            bytes('ONE\r\nunchanged\r\ntwo'),
            bytes('one\r\nunchanged\r\nTWO'),
        );

        expect(result.status).toBe('merged');
        expect(decoder.decode(result.content)).toBe('ONE\r\nunchanged\r\nTWO');
    });

    it('keeps adjacent edits conservative', () => {
        const result = mergeText(
            bytes('one\ntwo\n'),
            bytes('ONE\ntwo\n'),
            bytes('one\nTWO\n'),
        );

        expect(result).toEqual({status:'conflict'});
    });

    it('does not attempt to merge binary content', () => {
        const result = mergeText(
            new Uint8Array([0, 1]),
            new Uint8Array([0, 2]),
            new Uint8Array([0, 3]),
        );

        expect(result).toEqual({status:'binary'});
        expect(encodeTextBase(new Uint8Array([0, 1]))).toBeUndefined();
    });
});
