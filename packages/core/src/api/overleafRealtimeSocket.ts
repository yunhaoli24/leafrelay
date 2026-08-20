import {EventEmitter} from 'node:events';

const PACKET_TYPES = [
    'disconnect',
    'connect',
    'heartbeat',
    'message',
    'json',
    'event',
    'ack',
    'error',
    'noop',
] as const;

type PacketType = typeof PACKET_TYPES[number];

interface SocketPacket {
    type?: PacketType;
    id?: string;
    ack?: true | 'data';
    endpoint?: string;
    name?: string;
    args?: unknown[];
    data?: unknown;
    ackId?: string;
    reason?: string;
    advice?: string;
}

export interface OverleafRealtimeSocketOptions {
    origin: string;
    cookie: string;
    reconnect?: boolean;
    reconnectionDelay?: number;
    reconnectionLimit?: number;
    maxReconnectionAttempts?: number;
    fetch?:typeof fetch;
}

function encodePacket(packet: SocketPacket): string {
    const type = PACKET_TYPES.indexOf(packet.type ?? 'noop');
    const id = packet.id ?? '';
    let data: string | undefined;

    switch (packet.type) {
        case 'event':
            data = JSON.stringify({name:packet.name, args:packet.args ?? []});
            break;
        case 'ack':
            data = `${packet.ackId ?? ''}${packet.args?.length ? `+${JSON.stringify(packet.args)}` : ''}`;
            break;
        case 'message':
            data = String(packet.data ?? '');
            break;
        case 'json':
            data = JSON.stringify(packet.data);
            break;
        default:
            break;
    }

    const fields = [String(type), `${id}${packet.ack==='data' ? '+' : ''}`, packet.endpoint ?? ''];
    if (data!==undefined) { fields.push(data); }
    return fields.join(':');
}

function decodePacket(value: string): SocketPacket {
    const match = value.match(/([^:]+):([0-9]+)?(\+)?:([^:]+)?:?([\s\S]*)?/);
    if (!match) { return {}; }

    const packet:SocketPacket = {
        type:PACKET_TYPES[Number(match[1])],
        endpoint:match[4] || '',
    };
    if (match[2]) {
        packet.id = match[2];
        packet.ack = match[3] ? 'data' : true;
    }

    const data = match[5] || '';
    switch (packet.type) {
        case 'event': {
            const event = JSON.parse(data) as {name:string; args?:unknown[]};
            packet.name = event.name;
            packet.args = event.args ?? [];
            break;
        }
        case 'ack': {
            const ack = data.match(/^([0-9]+)(\+)?([\s\S]*)/);
            if (ack) {
                packet.ackId = ack[1];
                packet.args = ack[3] ? JSON.parse(ack[3]) as unknown[] : [];
            }
            break;
        }
        case 'error': {
            const [reason, advice] = data.split('+');
            packet.reason = ['transport not supported', 'client not handshaken', 'unauthorized'][Number(reason)] ?? '';
            packet.advice = ['reconnect'][Number(advice)] ?? '';
            break;
        }
        case 'json':
            packet.data = JSON.parse(data);
            break;
        case 'message':
            packet.data = data;
            break;
        default:
            break;
    }
    return packet;
}

function decodePayload(value: string): SocketPacket[] {
    if (!value.startsWith('\ufffd')) { return [decodePacket(value)]; }
    const packets:SocketPacket[] = [];
    let offset = 1;
    while (offset<value.length) {
        const separator = value.indexOf('\ufffd', offset);
        if (separator===-1) { break; }
        const length = Number(value.slice(offset, separator));
        const start = separator+1;
        packets.push(decodePacket(value.slice(start, start+length)));
        offset = start+length+1;
    }
    return packets;
}

function mergeCookies(current: string, additions: string[]): string {
    const cookies = new Map<string, string>();
    for (const value of [current, ...additions.map(cookie => cookie.split(';', 1)[0])]) {
        for (const part of value.split(';')) {
            const separator = part.indexOf('=');
            if (separator===-1) { continue; }
            cookies.set(part.slice(0, separator).trim(), part.slice(separator+1).trim());
        }
    }
    return [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
}

export class OverleafRealtimeSocket {
    private readonly events = new EventEmitter();
    private readonly endpoint: URL;
    private readonly origin: string;
    private cookie: string;
    private socket?: WebSocket;
    private connected = false;
    private explicitlyDisconnected = false;
    private reconnectEnabled: boolean;
    private reconnectAttempts = 0;
    private reconnectTimer?: NodeJS.Timeout;
    private inactivityTimer?: NodeJS.Timeout;
    private closeTimeoutMs = 60_000;
    private acknowledgementId = 0;
    private readonly acknowledgements = new Map<string, (...args:unknown[]) => void>();
    private readonly sendBuffer: string[] = [];

    readonly io = {
        reconnect:(enabled:boolean) => {
            this.reconnectEnabled = enabled;
            if (!enabled && this.reconnectTimer) {
                clearTimeout(this.reconnectTimer);
                this.reconnectTimer = undefined;
            }
        },
    };

    constructor(url: string, private readonly options: OverleafRealtimeSocketOptions) {
        this.endpoint = new URL(url);
        this.origin = options.origin;
        this.cookie = options.cookie;
        this.reconnectEnabled = options.reconnect ?? true;
        void this.connect();
    }

    on(event: string, handler: (...args:any[]) => void): this {
        this.events.on(event, handler);
        return this;
    }

    once(event: string, handler: (...args:any[]) => void): this {
        this.events.once(event, handler);
        return this;
    }

    removeListener(event: string, handler: (...args:any[]) => void): this {
        this.events.removeListener(event, handler);
        return this;
    }

    removeAllListeners(event?: string): this {
        this.events.removeAllListeners(event);
        return this;
    }

    emit(event: string, ...args:any[]): this {
        const callback = typeof args.at(-1)==='function' ? args.pop() as (...values:unknown[]) => void : undefined;
        const id = callback ? String(++this.acknowledgementId) : undefined;
        if (id && callback) { this.acknowledgements.set(id, callback); }
        this.send(encodePacket({
            type:'event',
            id,
            ack:callback ? 'data' : undefined,
            name:event,
            args,
        }));
        return this;
    }

    disconnect(): this {
        this.explicitlyDisconnected = true;
        this.reconnectEnabled = false;
        if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); }
        if (this.connected) { this.send(encodePacket({type:'disconnect'})); }
        this.closeSocket('booted');
        return this;
    }

    private async connect(): Promise<void> {
        try {
            const handshakeUrl = new URL('/socket.io/1/', this.endpoint.origin);
            for (const [name, value] of this.endpoint.searchParams) {
                handshakeUrl.searchParams.set(name, value);
            }
            handshakeUrl.searchParams.set('t', String(Date.now()));
            const response = await (this.options.fetch ?? fetch)(handshakeUrl, {
                headers:{origin:this.origin, cookie:this.cookie},
                redirect:'manual',
            });
            if (!response.ok) {
                throw new Error(`Socket.IO handshake failed: HTTP ${response.status} ${await response.text()}`);
            }
            const setCookies = response.headers.getSetCookie?.() ?? [];
            this.cookie = mergeCookies(this.cookie, setCookies);
            const [sessionId, heartbeatTimeout, closeTimeout, transports] = (await response.text()).split(':');
            if (!sessionId || !transports?.split(',').includes('websocket')) {
                throw new Error('Overleaf did not offer a Socket.IO WebSocket transport.');
            }
            this.closeTimeoutMs = Math.max(Number(heartbeatTimeout), Number(closeTimeout), 10)*1000;

            const websocketUrl = new URL(`/socket.io/1/websocket/${sessionId}`, this.endpoint.origin);
            websocketUrl.protocol = websocketUrl.protocol==='https:' ? 'wss:' : 'ws:';
            websocketUrl.search = this.endpoint.search;
            this.socket = new WebSocket(websocketUrl, {
                headers:{origin:this.origin, cookie:this.cookie},
            });
            this.socket.addEventListener('open', () => this.events.emit('connecting', 'websocket'));
            this.socket.addEventListener('message', event => void this.receive(event.data));
            this.socket.addEventListener('error', error => this.events.emit('error', error));
            this.socket.addEventListener('close', () => this.handleClose());
        } catch (error) {
            this.events.emit('connect_failed', error);
            this.events.emit('error', error);
            this.scheduleReconnect();
        }
    }

    private async receive(data: unknown) {
        this.resetInactivityTimer();
        const value = typeof data==='string'
            ? data
            : data instanceof Blob
                ? await data.text()
                : Buffer.from(data as ArrayBuffer).toString('utf8');
        for (const packet of decodePayload(value)) { this.handlePacket(packet); }
    }

    private handlePacket(packet: SocketPacket) {
        switch (packet.type) {
            case 'connect': {
                const wasReconnecting = this.reconnectAttempts>0;
                this.connected = true;
                this.events.emit('connect');
                this.flush();
                if (wasReconnecting) {
                    this.events.emit('reconnect', 'websocket', this.reconnectAttempts);
                    this.reconnectAttempts = 0;
                }
                break;
            }
            case 'heartbeat':
                this.send(encodePacket({type:'heartbeat'}));
                break;
            case 'event': {
                const args = [...(packet.args ?? [])];
                if (packet.ack==='data' && packet.id) {
                    args.push((...acknowledgement:unknown[]) => {
                        this.send(encodePacket({type:'ack', ackId:packet.id, args:acknowledgement}));
                    });
                }
                this.events.emit(packet.name ?? '', ...args);
                break;
            }
            case 'ack': {
                const callback = packet.ackId && this.acknowledgements.get(packet.ackId);
                if (callback && packet.ackId) {
                    this.acknowledgements.delete(packet.ackId);
                    callback(...(packet.args ?? []));
                }
                break;
            }
            case 'disconnect':
                this.closeSocket('booted');
                break;
            case 'error':
                this.events.emit('error', packet.reason || 'Socket.IO protocol error');
                if (packet.advice==='reconnect') { this.closeSocket('server error'); }
                break;
            case 'message':
            case 'json':
                this.events.emit('message', packet.data);
                break;
            default:
                break;
        }
    }

    private send(packet: string) {
        if (!this.connected || this.socket?.readyState!==WebSocket.OPEN) {
            this.sendBuffer.push(packet);
            return;
        }
        this.socket.send(packet);
    }

    private flush() {
        while (this.sendBuffer.length>0 && this.socket?.readyState===WebSocket.OPEN) {
            this.socket.send(this.sendBuffer.shift()!);
        }
    }

    private resetInactivityTimer() {
        if (this.inactivityTimer) { clearTimeout(this.inactivityTimer); }
        this.inactivityTimer = setTimeout(() => this.closeSocket('timeout'), this.closeTimeoutMs);
    }

    private handleClose() {
        const wasConnected = this.connected;
        this.connected = false;
        if (this.inactivityTimer) { clearTimeout(this.inactivityTimer); }
        if (wasConnected) { this.events.emit('disconnect', 'transport close'); }
        this.scheduleReconnect();
    }

    private closeSocket(reason: string) {
        const wasConnected = this.connected;
        this.connected = false;
        if (this.inactivityTimer) { clearTimeout(this.inactivityTimer); }
        const socket = this.socket;
        this.socket = undefined;
        socket?.close();
        if (wasConnected) { this.events.emit('disconnect', reason); }
        if (!this.explicitlyDisconnected) { this.scheduleReconnect(); }
    }

    private scheduleReconnect() {
        if (!this.reconnectEnabled || this.explicitlyDisconnected || this.reconnectTimer) { return; }
        const maxAttempts = this.options.maxReconnectionAttempts ?? 10;
        if (this.reconnectAttempts>=maxAttempts) {
            this.events.emit('reconnect_failed');
            return;
        }
        this.reconnectAttempts += 1;
        const initial = this.options.reconnectionDelay ?? 1000;
        const limit = this.options.reconnectionLimit ?? 16_000;
        const delay = Math.min(initial*2**(this.reconnectAttempts-1), limit);
        this.events.emit('reconnecting', delay, this.reconnectAttempts);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;
            void this.connect();
        }, delay);
    }
}

export const overleafSocketProtocol = {encodePacket, decodePacket, decodePayload};
