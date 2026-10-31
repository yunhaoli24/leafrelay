import { defineConfig } from 'tsdown';

export default defineConfig({
    entry: ['src/index.ts'],
    format: ['esm'],
    fixedExtension: false,
    platform: 'node',
    target: 'node24',
    sourcemap: true,
    dts: true,
    clean: true,
});
