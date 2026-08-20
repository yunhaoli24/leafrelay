import * as vscode from 'vscode';

export const OVERLEAF_URI_SCHEME = 'overleaf-workshop';
export const EXTENSION_NAMESPACE = 'leafrelay';
export const ELEGANT_NAME = 'LeafRelay';

export const OUTPUT_FOLDER_NAME = vscode.workspace.getConfiguration(EXTENSION_NAMESPACE).get('compileOutputFolderName', '.output') || '.output';
