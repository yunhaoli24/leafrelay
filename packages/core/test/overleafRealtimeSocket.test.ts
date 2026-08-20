import {describe, expect, it} from 'vitest';
import {overleafSocketProtocol} from '../src/api/overleafRealtimeSocket';

describe('Overleaf Socket.IO protocol', () => {
    it('encodes and decodes events with acknowledgements', () => {
        const encoded = overleafSocketProtocol.encodePacket({
            type:'event',
            id:'7',
            ack:'data',
            name:'joinDoc',
            args:['document-id', {encodeRanges:true}],
        });

        expect(encoded).toBe('5:7+::{"name":"joinDoc","args":["document-id",{"encodeRanges":true}]}');
        expect(overleafSocketProtocol.decodePacket(encoded)).toMatchObject({
            type:'event',
            id:'7',
            ack:'data',
            name:'joinDoc',
            args:['document-id', {encodeRanges:true}],
        });
    });

    it('decodes acknowledgements and heartbeat packets', () => {
        expect(overleafSocketProtocol.decodePacket('6:::4+[null,"ok",12]')).toMatchObject({
            type:'ack',
            ackId:'4',
            args:[null, 'ok', 12],
        });
        expect(overleafSocketProtocol.decodePacket('2::')).toMatchObject({type:'heartbeat'});
    });
});
