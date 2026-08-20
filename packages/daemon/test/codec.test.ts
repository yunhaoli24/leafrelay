import {describe, expect, it} from 'vitest';
import {decodeRpcValue, encodeRpcValue} from '../src/codec';

describe('RPC binary codec', () => {
    it('round-trips nested binary values without changing JSON data', () => {
        const value = {name:'paper.pdf', content:new Uint8Array([0, 1, 127, 255]), nested:[true, new Uint8Array([42])]};
        const encoded = encodeRpcValue(value);
        expect(encoded).toEqual({
            name:'paper.pdf',
            content:{$leafrelay:'bytes', base64:'AAF//w=='},
            nested:[true, {$leafrelay:'bytes', base64:'Kg=='}],
        });
        expect(decodeRpcValue(encoded)).toEqual(value);
    });
});
