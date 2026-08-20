import type {EncodedBinary} from '@leafrelay/protocol';

function isEncodedBinary(value:unknown):value is EncodedBinary {
    return typeof value==='object' && value!==null
        && (value as Partial<EncodedBinary>).$leafrelay==='bytes'
        && typeof (value as Partial<EncodedBinary>).base64==='string';
}

export function encodeRpcValue(value:unknown):unknown {
    if (value instanceof Uint8Array) {
        return {$leafrelay:'bytes', base64:Buffer.from(value).toString('base64')} satisfies EncodedBinary;
    }
    if (Array.isArray(value)) { return value.map(encodeRpcValue); }
    if (typeof value==='object' && value!==null) {
        return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, encodeRpcValue(child)]));
    }
    return value;
}

export function decodeRpcValue(value:unknown):unknown {
    if (isEncodedBinary(value)) { return Uint8Array.from(Buffer.from(value.base64, 'base64')); }
    if (Array.isArray(value)) { return value.map(decodeRpcValue); }
    if (typeof value==='object' && value!==null) {
        return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, decodeRpcValue(child)]));
    }
    return value;
}
