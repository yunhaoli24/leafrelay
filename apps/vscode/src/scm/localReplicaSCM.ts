import * as vscode from 'vscode';
import {homedir} from 'node:os';
import {sep} from 'node:path';
import type {ReplicaAttachResult, ReplicaConflictNotification, ReplicaStatusNotification} from '@leafrelay/protocol';
import {BaseSCM, CommitItem, SettingItem} from '.';
import {VirtualFileSystem} from '../core/remoteFileSystemProvider';
import {DaemonService} from '../utils/daemonService';
import {log, warn} from '../utils/outputChannel';

const IGNORE_SETTING_KEY = 'ignore-patterns';

export class LocalReplicaSCMProvider extends BaseSCM {
    static readonly label = vscode.l10n.t('Local Replica');
    readonly iconPath = new vscode.ThemeIcon('folder-library');

    private replica?:ReplicaAttachResult;
    private conflicts = new Set<string>();
    private conflictPromptActive = false;

    constructor(
        protected readonly vfs:VirtualFileSystem,
        public readonly baseUri:vscode.Uri,
    ) {
        super(vfs, baseUri);
    }

    private static sanitizeProjectFolderName(projectName:string):string {
        let sanitized = process.platform==='win32'
            ? projectName.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/[. ]+$/g, '')
            : projectName.replace(/[\/\x00]/g, '_');
        if (process.platform==='win32' && /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(sanitized)) {
            sanitized = `${sanitized}_`;
        }
        if (sanitized==='' || sanitized==='.' || sanitized==='..') { return 'untitled-project'; }
        return sanitized;
    }

    static async validateBaseUri(uri:string, projectName?:string):Promise<vscode.Uri> {
        try {
            let baseUri = vscode.Uri.file(uri);
            const folderName = projectName===undefined ? undefined : this.sanitizeProjectFolderName(projectName);
            try {
                const stat = await vscode.workspace.fs.stat(baseUri);
                if (stat.type!==vscode.FileType.Directory) { throw new Error('Not a folder'); }
                if (folderName && !baseUri.path.endsWith(`/${folderName}`)) {
                    baseUri = vscode.Uri.joinPath(baseUri, folderName);
                }
            } catch {
                // The selected directory may not exist yet.
            }
            await vscode.workspace.fs.createDirectory(baseUri);
            await vscode.workspace.fs.stat(baseUri);
            return baseUri;
        } catch (validationError) {
            await vscode.window.showErrorMessage(vscode.l10n.t('Invalid Path. Please make sure the absolute path to a folder with read/write permissions is used.'));
            throw validationError;
        }
    }

    static async pathToUri(path:string):Promise<vscode.Uri|undefined> {
        const root = await this.localWorkspaceRoot();
        if (!root || this.isHiddenPath(path)) { return undefined; }
        return vscode.Uri.joinPath(root, path);
    }

    static async uriToPath(uri:vscode.Uri):Promise<string|undefined> {
        const root = await this.localWorkspaceRoot();
        if (!root) { return undefined; }
        const path = uri.path.slice(root.path.length);
        return this.isHiddenPath(path) ? undefined : path;
    }

    static async readSettings():Promise<any|undefined> {
        const root = vscode.workspace.workspaceFolders?.length===1 ? vscode.workspace.workspaceFolders[0].uri : undefined;
        if (root?.scheme!=='file') { return undefined; }
        try {
            const content = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, '.overleaf', 'settings.json'));
            return JSON.parse(new TextDecoder().decode(content));
        } catch {
            return undefined;
        }
    }

    static get baseUriInputBox():vscode.QuickPick<vscode.QuickPickItem> {
        const inputBox = vscode.window.createQuickPick();
        inputBox.placeholder = vscode.l10n.t('e.g., /home/user/empty/local/folder');
        inputBox.value = homedir()+sep;
        inputBox.onDidChangeValue(async value => {
            const parent = value.split(sep).slice(0, -1).join(sep);
            if (!parent) { return; }
            try {
                inputBox.busy = true;
                const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(parent));
                inputBox.items = entries
                    .filter(([, type]) => type===vscode.FileType.Directory)
                    .filter(([name]) => `${parent}${sep}${name}`.startsWith(value))
                    .map(([name]) => ({label:name, alwaysShow:true}));
            } finally {
                inputBox.busy = false;
                inputBox.activeItems = [];
            }
        });
        inputBox.onDidAccept(() => {
            const selected = inputBox.selectedItems[0];
            if (!selected) { return; }
            const parent = inputBox.value.split(sep).slice(0, -1).join(sep);
            inputBox.value = `${parent}${sep}${selected.label}${sep}`;
        });
        return inputBox;
    }

    async writeFile(path:string, content:Uint8Array):Promise<void> {
        await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(this.baseUri, path), content);
    }

    async readFile(path:string):Promise<Uint8Array|undefined> {
        try {
            return await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.baseUri, path));
        } catch {
            return undefined;
        }
    }

    list():Iterable<CommitItem> { return []; }
    async apply(_commitItem:CommitItem):Promise<void> {}
    async syncFromSCM(_commits:Iterable<CommitItem>):Promise<void> {}

    get triggers():Promise<vscode.Disposable[]> {
        return this.attach();
    }

    get settingItems():SettingItem[] {
        const items:SettingItem[] = [];
        if (this.conflicts.size!==0) {
            items.push({
                label:vscode.l10n.t('Resolve Sync Conflicts ...'),
                description:vscode.l10n.t('{count} unresolved', {count:this.conflicts.size}),
                callback:() => this.selectConflict(),
            });
        }
        items.push({
            label:vscode.l10n.t('Configure sync ignore patterns ...'),
            callback:() => this.configureIgnorePatterns(),
        });
        return items;
    }

    private async attach():Promise<vscode.Disposable[]> {
        await this.ensureSettings();
        const client = DaemonService.current;
        const statusListener = client.onReplicaStatus(event => this.handleStatus(event));
        const conflictListener = client.onReplicaConflict(event => this.handleConflict(event));
        try {
            this.replica = await client.attachReplica({directory:this.baseUri.fsPath});
            this.conflicts = new Set(this.replica.conflicts);
            this.status = this.replica.status.state==='active'
                ? {status:'idle', message:vscode.l10n.t('Synced')}
                : {
                    status:'need-attention',
                    message:this.conflicts.size!==0
                        ? vscode.l10n.t('{count} conflict(s)', {count:this.conflicts.size})
                        : this.replica.status.message,
                };
            log('Local replica attached to daemon', {
                replicaId:this.replica.replicaId,
                projectId:this.replica.projectId,
                baseUri:this.replica.root,
                shared:this.replica.shared,
            });
            if (this.conflicts.size!==0) {
                warn(`Local replica attached with ${this.conflicts.size} unresolved conflict(s): ${[...this.conflicts].join(', ')}`);
                void this.promptNextConflict();
            }
            return [
                statusListener,
                conflictListener,
                {dispose:() => {
                    if (this.replica) { void client.detachReplica(this.replica.replicaId); }
                    this.replica = undefined;
                }},
            ];
        } catch (attachError) {
            statusListener.dispose();
            conflictListener.dispose();
            throw attachError;
        }
    }

    private handleStatus(event:ReplicaStatusNotification):void {
        if (event.replicaId!==this.replica?.replicaId) { return; }
        if (event.status.state==='active') {
            this.status = this.conflicts.size===0
                ? {status:'idle', message:vscode.l10n.t('Synced')}
                : {
                    status:'need-attention',
                    message:vscode.l10n.t('{count} conflict(s)', {count:this.conflicts.size}),
                };
        } else if (event.status.state==='starting' || event.status.state==='syncing') {
            this.status = {status:'pull', message:event.status.message};
        } else {
            this.status = {status:'need-attention', message:event.status.message};
        }
    }

    private handleConflict(event:ReplicaConflictNotification):void {
        if (event.replicaId!==this.replica?.replicaId) { return; }
        const isNew = !this.conflicts.has(event.path);
        this.conflicts = new Set(event.conflicts);
        this.status = {
            status:'need-attention',
            message:vscode.l10n.t('{count} conflict(s)', {count:this.conflicts.size}),
        };
        warn(`Synchronization conflict in ${event.path}: ${event.reason}`);
        if (isNew || !this.conflictPromptActive) { void this.promptNextConflict(); }
    }

    private async selectConflict():Promise<void> {
        const paths = [...this.conflicts].sort();
        if (paths.length===0) { return; }
        const path = paths.length===1
            ? paths[0]
            : await vscode.window.showQuickPick(paths, {
                title:vscode.l10n.t('Resolve Sync Conflict'),
                placeHolder:vscode.l10n.t('Select a conflicting path'),
            });
        if (path) { await this.promptConflict(path); }
    }

    private async promptNextConflict():Promise<void> {
        if (this.conflictPromptActive) { return; }
        const path = [...this.conflicts].sort()[0];
        if (!path) { return; }
        await this.promptConflict(path);
    }

    private async promptConflict(path:string):Promise<void> {
        if (this.conflictPromptActive || !this.conflicts.has(path)) { return; }
        this.conflictPromptActive = true;
        const remaining = this.conflicts.size;
        const choice = await vscode.window.showWarningMessage(
            `LeafRelay paused ${path} because both local and Overleaf changed (${remaining} conflict${remaining===1 ? '' : 's'} remaining).`,
            'Review Difference',
            'Use Local',
            'Use Overleaf',
            ...(remaining>1 ? ['Use Local for All', 'Use Overleaf for All'] : []),
        );
        try {
            await this.handleConflictChoice(path, choice);
        } finally {
            this.conflictPromptActive = false;
        }
        if (choice!==undefined) { await this.promptNextConflict(); }
    }

    private async handleConflictChoice(path:string, choice:string|undefined):Promise<void> {
        if (choice==='Review Difference') {
            await vscode.commands.executeCommand(
                'vscode.diff',
                this.vfs.pathToUri(path),
                vscode.Uri.joinPath(this.baseUri, path),
                `Overleaf <-> Local: ${path}`,
            );
            return;
        }
        if (choice==='Use Local') { await this.resolveConflict(path, 'local'); }
        if (choice==='Use Overleaf') { await this.resolveConflict(path, 'remote'); }
        if (choice==='Use Local for All' || choice==='Use Overleaf for All') {
            const winner = choice==='Use Local for All' ? 'local' : 'remote';
            for (const conflictPath of [...this.conflicts].sort()) {
                await this.resolveConflict(conflictPath, winner);
            }
        }
    }

    private async resolveConflict(path:string, winner:'local'|'remote'):Promise<void> {
        if (!this.replica) { return; }
        await DaemonService.current.resolveConflict({replicaId:this.replica.replicaId, path, winner});
        this.conflicts.delete(path);
        this.status = this.conflicts.size===0
            ? {status:'idle', message:vscode.l10n.t('Synced')}
            : {
                status:'need-attention',
                message:vscode.l10n.t('{count} conflict(s)', {count:this.conflicts.size}),
            };
    }

    private async configureIgnorePatterns():Promise<void> {
        const configured = this.getSetting<string[]>(IGNORE_SETTING_KEY) ?? [];
        const value = await vscode.window.showInputBox({
            title:vscode.l10n.t('Additional sync ignore patterns'),
            prompt:vscode.l10n.t('Comma-separated glob patterns. Built-in LaTeX outputs and hidden folders are always ignored.'),
            value:configured.join(', '),
            ignoreFocusOut:true,
        });
        if (value===undefined) { return; }
        const patterns = value.split(',').map(pattern => pattern.trim()).filter(Boolean);
        this.setSetting(IGNORE_SETTING_KEY, patterns);
        await this.ensureSettings();
        if (this.replica) {
            await DaemonService.current.detachReplica(this.replica.replicaId);
            this.replica = await DaemonService.current.attachReplica({directory:this.baseUri.fsPath});
        }
    }

    private async ensureSettings():Promise<void> {
        const settingsUri = vscode.Uri.joinPath(this.baseUri, '.overleaf', 'settings.json');
        let current:Record<string,unknown> = {};
        try {
            current = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(settingsUri)));
        } catch {
            await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.baseUri, '.overleaf'));
        }
        current.uri = this.vfs.origin.toString();
        current.serverName = this.vfs.serverName;
        current.projectName = this.vfs.projectName;
        current.enableCompileNPreview ??= false;
        current.localReplica = {settings:this.settings ?? {}};
        await vscode.workspace.fs.writeFile(settingsUri, new TextEncoder().encode(`${JSON.stringify(current, null, 2)}\n`));
    }

    private static async localWorkspaceRoot():Promise<vscode.Uri|undefined> {
        const root = vscode.workspace.workspaceFolders?.length===1 ? vscode.workspace.workspaceFolders[0].uri : undefined;
        if (root?.scheme!=='file') { return undefined; }
        try {
            await vscode.workspace.fs.stat(vscode.Uri.joinPath(root, '.overleaf', 'settings.json'));
            return root;
        } catch {
            return undefined;
        }
    }

    private static isHiddenPath(path:string):boolean {
        return path.replace(/\\/g, '/').split('/').some(part => part.startsWith('.'));
    }
}
