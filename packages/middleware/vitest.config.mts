import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['__test__/**/*.spec.ts'],
    exclude: ['node_modules', 'dist'],
    // Compares byte arrays in toEqual and toStrictEqual with Buffer.compare,
    // as in the tests of the core package.
    setupFiles: ['../../__test__/byte-array-equality.ts'],
  },
});
