import * as vscode from 'vscode';
import fuzzysearch from 'fuzzysearch';
import { OVERLEAF_URI_SCHEME } from '../consts';
import { RemoteFileSystemProvider } from '../core/remoteFileSystemProvider';

export function fuzzyFilter<T extends object>(list: T[], target: string, keys?: (keyof T)[]) {
    if (typeof list[0] === 'string') {
        return list.filter(item => fuzzysearch(target, String(item)));
    }

    const filterKeys = keys ?? Object.keys(list[0]) as (keyof T)[];
    return list.filter(item => filterKeys.some(key => fuzzysearch(target, String(item[key]))));
}

export abstract class IntellisenseProvider {
    protected selector = {scheme: OVERLEAF_URI_SCHEME};
    protected abstract readonly contextPrefix: string[][];

    constructor(protected readonly vfsm: RemoteFileSystemProvider) {}
    abstract get triggers(): vscode.Disposable[];

    protected get contextRegex() {
        const prefix = this.contextPrefix
            .map(group => `\\\\(${group.join('|')})`)
            .join('|');
        const postfix = String.raw`(\[[^\]]*\])*\{([^\}\$]*)\}?`;
        return new RegExp(`(?:${prefix})` + postfix);
    }
}
