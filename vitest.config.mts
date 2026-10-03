import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['__test__/**/*.spec.ts'],
    alias: [
      // browser-streaming.js imports the wasm-bindgen build, which Node tests
      // do not build. Its adapters only call the one-shot functions, which
      // the native addon provides with the same behaviour.
      {
        find: /^\.\/comprs-wasm\.js$/,
        replacement: fileURLToPath(new URL('./__test__/wasm-bindgen-stub.ts', import.meta.url)),
      },
    ],
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
