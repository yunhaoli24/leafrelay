import * as vscode from 'vscode';
import { VirtualFileSystem } from '../core/remoteFileSystemProvider';

import { BaseSCM, CommitItem, SettingItem } from ".";
import { LocalReplicaSCMProvider } from './localReplicaSCM';
import { LocalGitBridgeSCMProvider } from './localGitBridgeSCM'; 
import { HistoryViewProvider } from './historyViewProvider';
import { GlobalStateManager } from '../utils/globalStateManager';
import { EventBus } from '../utils/eventBus';
import { EXTENSION_NAMESPACE } from '../consts';
import { error as logError, log, notifyError } from '../utils/outputChannel';
import { partitionLocalReplicas } from './localReplicaSelection';

const supportedSCMs = [
    LocalReplicaSCMProvider,
    // LocalGitBridgeSCMProvider,
];
type SupportedSCM = typeof supportedSCMs[number];

class CoreSCMProvider extends BaseSCM {
    constructor(protected readonly vfs: VirtualFileSystem) {
        super(vfs, vfs.origin);
    }

    validateBaseUri() { return Promise.resolve(true); }
    async syncFromSCM() {}
    async apply(commitItem: CommitItem) {};
    get triggers() { return Promise.resolve([]); }
    get settingItems() { return[]; }

    writeFile(path: string, content: Uint8Array): Thenable<void> {
        const uri = this.vfs.pathToUri(path);
        return vscode.workspace.fs.writeFile(uri, content);
    }

    readFile(path: string): Thenable<Uint8Array> {
        const uri = this.vfs.pathToUri(path);
        return vscode.workspace.fs.readFile(uri);
    }

    list(): Iterable<CommitItem> {
        return [];
    }
}

interface SCMRecord {
    scm: BaseSCM;
    enabled: boolean;
    triggers: vscode.Disposable[];
}

export class SCMCollectionProvider extends vscode.Disposable {
    private readonly core: CoreSCMProvider;
    private readonly scms: SCMRecord[] = [];
    private readonly statusBarItem: vscode.StatusBarItem;
    private readonly statusListener: vscode.Disposable;
    private historyDataProvider: HistoryViewProvider;

    constructor(
        private readonly vfs: VirtualFileSystem,
        private readonly context: vscode.ExtensionContext,
    ) {
        // define the dispose behavior
        super(() => {
            this.scms.forEach(scm => scm.triggers.forEach(t => t.dispose()));
        });

        this.core = new CoreSCMProvider( vfs );
        this.historyDataProvider = new HistoryViewProvider( vfs );
        void this.initSCMs().catch(error => {
            notifyError(
                'LeafRelay could not initialize synchronization for this project. Reload the window to retry.',
                error,
                `scm-initialization:${this.vfs.projectId}`,
                [{title:'Reload Window', run:() => vscode.commands.executeCommand('workbench.action.reloadWindow')}],
            );
        });

        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
        this.statusBarItem.command = `${EXTENSION_NAMESPACE}.projectSCM.configSCM`;
        this.statusListener = EventBus.on('scmStatusChangeEvent', () => {this.updateStatus();});
    }

    private updateStatus() {
        if (!this.statusBarItem) { return; }

        let numPush = 0, numPull = 0;
        let tooltip = new vscode.MarkdownString(`**${vscode.l10n.t('Project Source Control')}**\n\n`);
        tooltip.supportHtml = true;
        tooltip.supportThemeIcons = true;

        // update status bar item tooltip
        if (this.scms.length===0) {
            tooltip.appendMarkdown(`*${vscode.l10n.t('Click to configure.')}*\n\n`);
        } else {
            for (const {scm,enabled} of this.scms) {
                const icon = scm.iconPath.id;
                const label = (scm.constructor as any).label;
                const uri = scm.baseUri.toString();
                const slideUri = uri.length<=30? uri : uri.replace(/^(.{15}).*(.{15})$/, '$1...$2');
                tooltip.appendMarkdown(`----\n\n$(${icon}) **${label}**: [${slideUri}](${uri})\n\n`);
                //
                if (!enabled) {
                    tooltip.appendMarkdown(`&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;*${vscode.l10n.t('Disabled')}.*\n\n`);
                } else if (scm.status.status==='idle') {
                    tooltip.appendMarkdown(`&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;*${vscode.l10n.t('Synced')}.*\n\n`);
                } else {
                    // show status message
                    tooltip.appendMarkdown(`&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;***${scm.status.message}***\n\n`);
                    // update counters
                    switch (scm.status.status) {
                        case 'push': numPush++; break;
                        case 'pull': numPull++; break;
                    }
                }
            }   
        }
        this.statusBarItem.tooltip = tooltip;

        // update status bar item text
        if (numPush!==0) {
            this.statusBarItem.text = `$(cloud-upload)`;
        } else if (numPull!==0) {
            this.statusBarItem.text = `$(cloud-download)`;
        } else {
            this.statusBarItem.text = `$(cloud)`;
        }

        this.statusBarItem.show();
    }

    private async initSCMs() {
        const scmPersists = GlobalStateManager.getServerProjectSCMPersists(this.context, this.vfs.serverName, this.vfs.projectId);
        const records = Object.values(scmPersists).map(scmPersist => {
            const parsed = vscode.Uri.parse(scmPersist.baseUri);
            const baseUri = parsed.scheme==='' ? vscode.Uri.file(scmPersist.baseUri) : parsed;
            return {baseUri: baseUri.toString(), value: scmPersist};
        });
        const workspaceRoot = vscode.workspace.workspaceFolders?.length===1
            ? vscode.workspace.workspaceFolders[0].uri
            : undefined;
        const localReplicas = records.filter(record => record.value.label===LocalReplicaSCMProvider.label);
        const activeWorkspaceUri = workspaceRoot?.scheme==='file' ? workspaceRoot.toString() : undefined;
        const selected = partitionLocalReplicas(localReplicas, activeWorkspaceUri);
        const activeLocalReplicaUris = new Set(selected.active.map(record => record.baseUri));

        for (const record of records) {
            const scmPersist = record.value;
            const scmProto = supportedSCMs.find(scm => scm.label===scmPersist.label);
            if (scmProto===undefined) { continue; }
            if (scmProto===LocalReplicaSCMProvider && !activeLocalReplicaUris.has(record.baseUri)) {
                log('SCMCollection: skipped inactive local replica', {
                    projectId: this.vfs.projectId,
                    activeWorkspace: activeWorkspaceUri,
                    baseUri: record.baseUri,
                });
                continue;
            }
            await this.createSCM(scmProto, vscode.Uri.parse(record.baseUri), false, scmPersist.enabled ?? true);
        }

        if (selected.inactive.length!==0) {
            const inactivePaths = selected.inactive.map(record => vscode.Uri.parse(record.baseUri).fsPath);
            log('SCMCollection: other local replicas remain inactive', {
                projectId: this.vfs.projectId,
                inactivePaths,
            });
            const choice = await vscode.window.showWarningMessage(
                `This Overleaf project is linked to ${selected.inactive.length} other local folder(s). Only the current workspace will sync. Manage unwanted replicas from Open Project Locally.`,
                'Open LeafRelay',
            );
            if (choice==='Open LeafRelay') {
                await vscode.commands.executeCommand('workbench.view.extension.leafrelay');
            }
        }
    }

    private async createSCM(scmProto: SupportedSCM, baseUri: vscode.Uri, newSCM=false, enabled=true) {
        log('SCMCollection: creating SCM', {
            label: scmProto.label,
            baseUri: baseUri.toString(),
            projectId: this.vfs.projectId,
            newSCM,
            enabled,
        });
        const scm = new scmProto(this.vfs, baseUri);
        // insert into global state
        if (newSCM) {
            this.vfs.setProjectSCMPersist(scm.scmKey, {
                enabled: enabled,
                label: scmProto.label,
                baseUri: scm.baseUri.path,
                settings: {} as JSON,
            });
        }
        // insert into collection
        try {
            const triggers = enabled ? await scm.triggers : [];
            this.scms.push({scm,enabled,triggers});
            this.updateStatus();
            log('SCMCollection: SCM created', {label: scmProto.label, baseUri: baseUri.toString(), triggerCount: triggers.length});
            return scm;
        } catch (error) {
            if (newSCM) {
                this.vfs.setProjectSCMPersist(scm.scmKey, undefined);
            }
            logError('SCMCollection: SCM creation failed', {
                label: scmProto.label,
                baseUri: baseUri.toString(),
                projectId: this.vfs.projectId,
                error,
            });
            vscode.window.showErrorMessage( vscode.l10n.t('"{scm}" creation failed.', {scm:scmProto.label}) );
            return undefined;
        }
    }

    private removeSCM(item: SCMRecord) {
        const index = this.scms.indexOf(item);
        if (index!==-1) {
            // remove from collection
            item.triggers.forEach(trigger => trigger.dispose());
            this.scms.splice(index, 1);
            // remove from global state
            this.vfs.setProjectSCMPersist(item.scm.scmKey, undefined);
            this.updateStatus();
        }
    }

    private createNewSCM(scmProto: SupportedSCM) {
        return new Promise(resolve => {
            const inputBox = scmProto.baseUriInputBox;
            inputBox.ignoreFocusOut = true;
            inputBox.title = vscode.l10n.t('Create Source Control: {scm}', {scm:scmProto.label});
            inputBox.buttons = [{iconPath: new vscode.ThemeIcon('check')}];
            inputBox.show();
            //
            inputBox.onDidTriggerButton(() => {
                inputBox.hide();
                resolve(inputBox.value);
            });
            inputBox.onDidAccept(() => {
                if (inputBox.activeItems.length===0) {
                    inputBox.hide();
                    resolve(inputBox.value);
                }
            });
        })
        .then((uri) => {
            log('SCMCollection: validating new SCM path', {label: scmProto.label, uri});
            return scmProto.validateBaseUri(uri as string || '', this.vfs.projectName);
        })
        .then(async (baseUri) => {
            if (baseUri) {
                const scm = await this.createSCM(scmProto, baseUri, true);
                if (scm) {
                    vscode.window.showInformationMessage( vscode.l10n.t('"{scm}" created: {uri}.', {scm:scmProto.label, uri: decodeURI(scm.baseUri.toString()) }) );
                } else {
                    vscode.window.showErrorMessage( vscode.l10n.t('"{scm}" creation failed.', {scm:scmProto.label}) );
                }
            }
        })
        .catch(error => {
            notifyError(`Could not create ${scmProto.label}. See the LeafRelay output for details.`, error, 'scm-create-failed');
        });
    }

    private configSCM(scmItem: SCMRecord) {
        const baseUri = scmItem.scm.baseUri.toString();
        const settingItems = scmItem.scm.settingItems as SettingItem[];
        const status = scmItem.enabled? scmItem.scm.status.status : 'disabled';
        const quickPickItems = [
            {label:scmItem.enabled?'Disable':'Enable', description:`Status: ${status}`},
            {label:'Remove', description:`${baseUri}`},
            {label:'', kind:vscode.QuickPickItemKind.Separator},
            ...settingItems,
        ];

        return vscode.window.showQuickPick(quickPickItems, {
            ignoreFocusOut: true,
            title: vscode.l10n.t('Project Source Control Management'),
        }).then(async (select) => {
            if (select===undefined) { return; }
            switch (select.label) {
                case 'Enable':
                case 'Disable':
                    const persist = this.vfs.getProjectSCMPersist(scmItem.scm.scmKey);
                    persist.enabled = !(persist.enabled ?? true);
                    this.vfs.setProjectSCMPersist(scmItem.scm.scmKey, persist);
                    //
                    const scmIndex = this.scms.indexOf(scmItem);
                    this.scms[scmIndex].enabled = persist.enabled;
                    if (persist.enabled) {
                        scmItem.triggers = await scmItem.scm.triggers;
                    } else {
                        scmItem.triggers.forEach(trigger => trigger.dispose());
                        scmItem.triggers = [];
                    }
                    this.updateStatus();
                    vscode.window.showWarningMessage(`"${(scmItem.scm.constructor as any).label}" ${persist.enabled?'enabled':'disabled'}: ${baseUri}.`);
                    break;
                case 'Remove':
                    vscode.window.showWarningMessage(`${vscode.l10n.t('Remove')} ${baseUri}?`, 'Yes', 'No')
                    .then((select) => {
                        if (select==='Yes') {
                            this.removeSCM(scmItem);
                        }
                    });
                    break;
                default:
                    const settingItem = settingItems.find(item => item.label===select.label);
                    settingItem?.callback();
                    break;
            }
        });
    }

    showSCMConfiguration() {
        // group 1: show existing scms
        const scmItems: vscode.QuickPickItem[] = this.scms.map((item) => {
            const { scm } = item;
            return {
                label: (scm.constructor as any).label,
                iconPath: scm.iconPath,
                description: scm.baseUri.toString(),
                item,
            };
        });
        if (scmItems.length!==0) {
            scmItems.push({kind:vscode.QuickPickItemKind.Separator, label:''});
        }
        // group 2: create new scm
        const createItems: vscode.QuickPickItem[] = supportedSCMs.map((scmProto) => {
            return {
                label: vscode.l10n.t('Create Source Control: {scm}', {scm:scmProto.label}),
                scmProto,
            };
        });

        // show quick pick
        vscode.window.showQuickPick([...scmItems, ...createItems], {
            ignoreFocusOut: true,
            title: vscode.l10n.t('Project Source Control Management'),
        }).then((select) => {
            if (select) {
                const _select = select as any;
                // configure existing scm
                if (_select.item) {
                    this.configSCM( _select.item as SCMRecord );
                }
                // create new scm
                if ( _select.scmProto ) {
                    this.createNewSCM(_select.scmProto as SupportedSCM );
                }
            }
        });
    }

    get triggers() {
        return [
            // Register: HistoryViewProvider
            ...this.historyDataProvider.triggers,
            // register status bar item
            this.statusBarItem,
            this.statusListener,
            // register commands
            vscode.commands.registerCommand(`${EXTENSION_NAMESPACE}.projectSCM.configSCM`, () => {
                return this.showSCMConfiguration();
            }),
            vscode.commands.registerCommand(`${EXTENSION_NAMESPACE}.projectSCM.newSCM`, (scmProto) => {
                return this.createNewSCM(scmProto);
            }),
            this as vscode.Disposable,
        ];
    }
    
}
