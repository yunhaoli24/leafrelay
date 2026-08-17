import {expect, test} from 'vitest';
import {isMissingFileSystemError} from '../../src/utils/fileSystemErrors';

test('recognizes VS Code missing-file errors', () => {
    expect(isMissingFileSystemError({code: 'FileNotFound'})).toBe(true);
    expect(isMissingFileSystemError({code: 'EntryNotFound'})).toBe(true);
});

test('does not hide unrelated filesystem errors', () => {
    expect(isMissingFileSystemError({code: 'NoPermissions'})).toBe(false);
    expect(isMissingFileSystemError(new Error('network failure'))).toBe(false);
    expect(isMissingFileSystemError(null)).toBe(false);
});
