import * as vscode from 'vscode';
import { ELEGANT_NAME } from '../consts';
import {
    error as coreError,
    log as coreLog,
    setLogSink,
    warn as coreWarn,
} from '@leafrelay/core';

let outputChannel: vscode.LogOutputChannel | undefined;
const notificationTimes = new Map<string, number>();
const NOTIFICATION_COOLDOWN_MS = 30000;

export interface NotificationAction {
    title: string;
    run: () => void | PromiseLike<void>;
}

function formatArgument(argument: unknown): string {
    if (argument instanceof Error) {
        return argument.stack || argument.message;
    }
    if (typeof argument === 'string') {
        return argument;
    }
    try {
        const seen = new WeakSet<object>();
        return JSON.stringify(argument, (_key, value) => {
            if (value instanceof Error) {
                return Object.fromEntries(Object.getOwnPropertyNames(value).map(key => [key, (value as any)[key]]));
            }
            if (typeof value==='object' && value!==null) {
                if (seen.has(value)) { return '[Circular]'; }
                seen.add(value);
            }
            return value;
        });
    } catch {
        return String(argument);
    }
}

export function initOutputChannel(context: vscode.ExtensionContext): vscode.LogOutputChannel {
    if (outputChannel===undefined) {
        outputChannel = vscode.window.createOutputChannel(ELEGANT_NAME, {log:true});
        context.subscriptions.push(outputChannel);
        setLogSink((level, args) => {
            const message = args.map(formatArgument).join(' ');
            if (level==='error') {
                outputChannel?.error(message);
            } else if (level==='warn') {
                outputChannel?.warn(message);
            } else {
                outputChannel?.info(message);
            }
        });
    }
    return outputChannel;
}

export function log(...args: unknown[]) {
    coreLog(...args);
}

export function warn(...args: unknown[]) {
    coreWarn(...args);
}

export function error(...args: unknown[]) {
    coreError(...args);
}

export function notifyError(
    message: string,
    detail?: unknown,
    key: string = message,
    actions: NotificationAction[] = [],
) {
    coreError(...(detail===undefined ? [message] : [message, detail]));
    const now = Date.now();
    const previous = notificationTimes.get(key) || 0;
    if (now-previous<NOTIFICATION_COOLDOWN_MS) { return; }
    notificationTimes.set(key, now);
    vscode.window.showErrorMessage(message, ...actions.map(action => action.title), 'Show Logs').then(async choice => {
        if (choice==='Show Logs') {
            outputChannel?.show(true);
            return;
        }
        const action = actions.find(candidate => candidate.title===choice);
        if (action===undefined) { return; }
        notificationTimes.delete(key);
        try {
            await action.run();
        } catch (error) {
            coreError(`Notification action "${action.title}" failed.`, error);
        }
    }, () => {});
}
