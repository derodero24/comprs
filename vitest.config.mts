import codspeedPlugin from '@codspeed/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [codspeedPlugin()],
  test: {
    include: ['__test__/**/*.spec.ts'],
    exclude: ['node_modules', 'target', '.claude'],
    benchmark: {
      include: ['__test__/**/*.bench.ts'],
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: 'coverage',
      include: ['streams.js', 'node.js'],
      thresholds: {
        lines: 70,
        functions: 80,
        branches: 60,
      },
    },
  },
});
