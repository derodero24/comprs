import { defaultExclude, defineConfig } from 'vitest/config';

export default defineConfig(({ mode }) => ({
  test: {
    include: ['__test__/**/*.spec.ts'],
    exclude: ['node_modules', 'target', '.claude'],
    // Compares byte arrays in toEqual and toStrictEqual with Buffer.compare.
    setupFiles: ['__test__/byte-array-equality.ts'],
    benchmark: {
      include: ['__test__/**/*.bench.ts'],
      // `pnpm run bench:ci` (`vitest bench --mode ci`) leaves out the
      // comparisons with other libraries. The --exclude option cannot:
      // Vitest collects benchmark files with these two settings alone.
      exclude: mode === 'ci' ? [...defaultExclude, '**/*.compare.bench.ts'] : defaultExclude,
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: 'coverage',
      // The javascript flag in codecov.yml covers the same files.
      include: ['streams.js', 'node.js'],
      thresholds: {
        lines: 70,
        functions: 80,
        branches: 60,
      },
    },
  },
}));
