import { createRequire } from 'node:module';

export const socketIOClient = createRequire(import.meta.url)(
    './socket-runtime/node_modules/socket.io-client',
) as { connect(url: string, options: Record<string, unknown>): any };
