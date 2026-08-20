export type LogLevel = 'info' | 'warn' | 'error';

export type LogSink = (level: LogLevel, args: readonly unknown[]) => void;

let sink: LogSink | undefined;

export function setLogSink(nextSink: LogSink | undefined) {
    sink = nextSink;
}

function write(level: LogLevel, args: readonly unknown[]) {
    if (sink!==undefined) {
        sink(level, args);
        return;
    }
    const method = level==='error' ? console.error : level==='warn' ? console.warn : console.log;
    method(...args);
}

export function log(...args: unknown[]) {
    write('info', args);
}

export function warn(...args: unknown[]) {
    write('warn', args);
}

export function error(...args: unknown[]) {
    write('error', args);
}
