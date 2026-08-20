import {defineConfig} from 'vitest/config';

export default defineConfig({
    test: {
        include: ['apps/*/test/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
        exclude: ['data/vendor/**'],
    },
});
