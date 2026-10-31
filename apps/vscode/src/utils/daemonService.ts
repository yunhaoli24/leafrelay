import * as vscode from 'vscode';
import { DaemonVersionError, LeafRelayDaemonClient } from '@leafrelay/daemon';
import { log, notifyError, warn } from './outputChannel';

export class DaemonService {
    private static client?: LeafRelayDaemonClient;

    static async initialize(context: vscode.ExtensionContext): Promise<LeafRelayDaemonClient> {
        if (this.client) {
            return this.client;
        }
        const client = await LeafRelayDaemonClient.connect({
            clientName: 'vscode',
            clientVersion: context.extension.packageJSON.version,
            daemonEntrypoint: vscode.Uri.joinPath(context.extensionUri, 'out', 'daemon.js').fsPath,
        }).catch((error) => {
            if (error instanceof DaemonVersionError) {
                notifyError(error.message, error, 'daemon-version');
            }
            throw error;
        });
        client.onLog((event) => {
            if (event.level === 'error') {
                notifyError(event.message, undefined, 'daemon-connection');
            } else if (event.level === 'warn') {
                warn(event.message);
            } else {
                log(event.message);
            }
        });
        context.subscriptions.push({
            dispose: () => {
                client.close();
                if (this.client === client) {
                    this.client = undefined;
                }
            },
        });
        this.client = client;
        return client;
    }

    static get current(): LeafRelayDaemonClient {
        if (!this.client) {
            throw new Error('LeafRelay daemon client is not initialized.');
        }
        return this.client;
    }
}
