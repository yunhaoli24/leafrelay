import {diff3Merge} from 'node-diff3';

const textDecoder = new TextDecoder('utf-8', {fatal:true});
const textEncoder = new TextEncoder();

export interface TextMergeResult {
    status: 'merged'|'conflict'|'binary';
    content?: Uint8Array;
}

function decodeText(content: Uint8Array): string | undefined {
    if (content.includes(0)) { return undefined; }
    try {
        return textDecoder.decode(content);
    } catch {
        return undefined;
    }
}

function splitLines(content: string): string[] {
    return content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

export function encodeTextBase(content: Uint8Array): string | undefined {
    return decodeText(content);
}

export function mergeText(
    baseContent: Uint8Array,
    localContent: Uint8Array,
    remoteContent: Uint8Array,
): TextMergeResult {
    const base = decodeText(baseContent);
    const local = decodeText(localContent);
    const remote = decodeText(remoteContent);
    if (base===undefined || local===undefined || remote===undefined) {
        return {status:'binary'};
    }

    const regions = diff3Merge(
        splitLines(local),
        splitLines(base),
        splitLines(remote),
        {excludeFalseConflicts:true},
    );
    if (regions.some(region => region.conflict!==undefined)) {
        return {status:'conflict'};
    }
    return {
        status:'merged',
        content:textEncoder.encode(regions.flatMap(region => region.ok ?? []).join('')),
    };
}
