import { describe, expect, it, vi } from 'vitest';
import { OverleafRealtimeSocket, overleafSocketProtocol } from '../src/api/overleafRealtimeSocket';

describe('Overleaf Socket.IO protocol', () => {
    it('cancels an unfinished handshake when the project connection is disposed', async () => {
        let finish!: (response: Response) => void;
        const request = vi.fn<typeof fetch>(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const websocket = vi.spyOn(globalThis, 'WebSocket');
        try {
            const client = new OverleafRealtimeSocket('https://overleaf.test/?projectId=project', {
                origin: 'https://overleaf.test',
                cookie: 'test=value',
                fetch: request,
            });
            client.disconnect();
            expect(request.mock.calls[0][1]!.signal!.aborted).toBe(true);
            finish(new Response('session:60:60:websocket'));
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(websocket).not.toHaveBeenCalled();
        } finally {
            websocket.mockRestore();
        }
    });

    it('encodes and decodes events with acknowledgements', () => {
        const encoded = overleafSocketProtocol.encodePacket({
            type: 'event',
            id: '7',
            ack: 'data',
            name: 'joinDoc',
            args: ['document-id', { encodeRanges: true }],
        });

        expect(encoded).toBe('5:7+::{"name":"joinDoc","args":["document-id",{"encodeRanges":true}]}');
        expect(overleafSocketProtocol.decodePacket(encoded)).toMatchObject({
            type: 'event',
            id: '7',
            ack: 'data',
            name: 'joinDoc',
            args: ['document-id', { encodeRanges: true }],
        });
    });

    it('decodes acknowledgements and heartbeat packets', () => {
        expect(overleafSocketProtocol.decodePacket('6:::4+[null,"ok",12]')).toMatchObject({
            type: 'ack',
            ackId: '4',
            args: [null, 'ok', 12],
        });
        expect(overleafSocketProtocol.decodePacket('2::')).toMatchObject({ type: 'heartbeat' });
    });
});
