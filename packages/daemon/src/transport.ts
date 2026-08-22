import type {Socket} from 'node:net';
import {
    createMessageConnection,
    SocketMessageReader,
    SocketMessageWriter,
    type Message,
    type MessageConnection,
} from 'vscode-jsonrpc/node';

const CLOSED_SOCKET_ERRORS = new Set([
    'EPIPE',
    'ECONNRESET',
    'ERR_SOCKET_CLOSED',
    'ERR_STREAM_DESTROYED',
    'ERR_STREAM_WRITE_AFTER_END',
]);

class LeafRelaySocketWriter extends SocketMessageWriter {
    constructor(private readonly transportSocket:Socket) {
        super(transportSocket);
    }

    override async write(message:Message):Promise<void> {
        try {
            await super.write(message);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (this.transportSocket.destroyed || this.transportSocket.writableEnded || (code && CLOSED_SOCKET_ERRORS.has(code))) { return; }
            throw error;
        }
    }
}

export function createSocketRpcConnection(socket:Socket):MessageConnection {
    return createMessageConnection(new SocketMessageReader(socket), new LeafRelaySocketWriter(socket));
}
