import {LeafRelayDaemonClient} from '@leafrelay/daemon';

declare const LEAFRELAY_VERSION:string;

export function connectCliDaemon(autoStart=true):Promise<LeafRelayDaemonClient> {
    return LeafRelayDaemonClient.connect({
        clientName:'cli',
        clientVersion:LEAFRELAY_VERSION,
        daemonEntrypoint:new URL('./daemon.js', import.meta.url),
        autoStart,
    });
}
