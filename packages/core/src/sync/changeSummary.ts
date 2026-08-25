import DiffMatchPatch from 'diff-match-patch';

interface OffsetRange {
    oldStart:number;
    oldEnd:number;
    newStart:number;
    newEnd:number;
}

interface LineRange {
    start:number;
    end:number;
}

const decoder = new TextDecoder('utf-8', {fatal:true});

function decode(content:Uint8Array|undefined):string|undefined {
    if (content===undefined) { return ''; }
    if (content.includes(0)) { return undefined; }
    try { return decoder.decode(content); }
    catch { return undefined; }
}

function lineStarts(content:string):number[] {
    const starts = [0];
    for (let index = 0; index<content.length; index++) {
        if (content[index]==='\n' && index+1<content.length) { starts.push(index+1); }
    }
    return starts;
}

function lineAt(starts:number[], offset:number):number {
    let low = 0;
    let high = starts.length;
    while (low<high) {
        const middle = Math.floor((low+high)/2);
        if (starts[middle]<=offset) { low = middle+1; }
        else { high = middle; }
    }
    return Math.max(1, low);
}

function toLineRange(content:string, start:number, end:number):LineRange {
    const starts = lineStarts(content);
    const safeStart = Math.min(start, Math.max(0, content.length-1));
    const safeEnd = Math.min(Math.max(start, end-1), Math.max(0, content.length-1));
    return {start:lineAt(starts, safeStart), end:lineAt(starts, safeEnd)};
}

function mergeRanges(ranges:LineRange[]):LineRange[] {
    const merged:LineRange[] = [];
    for (const range of ranges.sort((a, b) => a.start-b.start)) {
        const previous = merged.at(-1);
        if (previous && range.start<=previous.end+1) { previous.end = Math.max(previous.end, range.end); }
        else { merged.push({...range}); }
    }
    return merged;
}

function formatRanges(ranges:LineRange[]):string {
    const shown = ranges.slice(0, 3).map(range => range.start===range.end
        ? String(range.start)
        : `${range.start}-${range.end}`);
    return `${shown.join(', ')}${ranges.length>shown.length ? ` (+${ranges.length-shown.length} more)` : ''}`;
}

export function describeContentChange(before:Uint8Array|undefined, after:Uint8Array|undefined):string|undefined {
    if (before && after && Buffer.from(before).equals(Buffer.from(after))) { return undefined; }
    const oldText = decode(before);
    const newText = decode(after);
    if (oldText===undefined || newText===undefined) {
        return `binary bytes ${(before?.byteLength ?? 0)} -> ${(after?.byteLength ?? 0)}`;
    }
    if (oldText.length===0 && newText.length===0) { return undefined; }
    if (oldText.length===0) {
        const count = lineStarts(newText).length;
        return `added lines ${count===1 ? '1' : `1-${count}`}`;
    }
    if (newText.length===0) {
        const count = lineStarts(oldText).length;
        return `removed lines ${count===1 ? '1' : `1-${count}`}`;
    }

    const changes:OffsetRange[] = [];
    let oldOffset = 0;
    let newOffset = 0;
    let current:OffsetRange|undefined;
    const finish = () => {
        if (current) { changes.push(current); current = undefined; }
    };
    for (const [operation, value] of new DiffMatchPatch().diff_main(oldText, newText)) {
        if (operation===0) {
            finish();
            oldOffset += value.length;
            newOffset += value.length;
            continue;
        }
        current ??= {oldStart:oldOffset, oldEnd:oldOffset, newStart:newOffset, newEnd:newOffset};
        if (operation===-1) { oldOffset += value.length; }
        if (operation===1) { newOffset += value.length; }
        current.oldEnd = oldOffset;
        current.newEnd = newOffset;
    }
    finish();

    const ranges = mergeRanges(changes.map(change => change.newEnd>change.newStart
        ? toLineRange(newText, change.newStart, change.newEnd)
        : toLineRange(oldText, change.oldStart, change.oldEnd)));
    return ranges.length===0 ? undefined : `lines ${formatRanges(ranges)}`;
}
