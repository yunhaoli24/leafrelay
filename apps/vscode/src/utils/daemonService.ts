import * as vscode from 'vscode';
import {LeafRelayDaemonClient} from '@leafrelay/daemon';
import {error, log, warn} from './outputChannel';

export class DaemonService {
    private static client?:LeafRelayDaemonClient;

    static async initialize(context:vscode.ExtensionContext):Promise<LeafRelayDaemonClient> {
        if (this.client) { return this.client; }
        const client = await LeafRelayDaemonClient.connect({
            clientName:'vscode',
            clientVersion:context.extension.packageJSON.version,
            daemonEntrypoint:vscode.Uri.joinPath(context.extensionUri, 'out', 'daemon.cjs').fsPath,
        });
        client.onLog(event => {
            if (event.level==='error') { error(event.message); }
            else if (event.level==='warn') { warn(event.message); }
            else { log(event.message); }
        });
        context.subscriptions.push({dispose:() => {
            client.close();
            if (this.client===client) { this.client = undefined; }
        }});
        this.client = client;
        return client;
    }

    static get current():LeafRelayDaemonClient {
        if (!this.client) { throw new Error('LeafRelay daemon client is not initialized.'); }
        return this.client;
    }
}
