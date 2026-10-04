import { fileURLToPath } from 'node:url';
import { normalizePath } from 'vite';
import type { Plugin } from 'vitest/config';
import { defaultExclude, defineConfig } from 'vitest/config';

// Module IDs use forward slashes, also on Windows.
const STREAM_ADAPTERS = normalizePath(
  fileURLToPath(new URL('./browser/streaming.js', import.meta.url)),
);
const WASM_BINDGEN_STUB = fileURLToPath(
  new URL('./__test__/wasm-bindgen-stub.ts', import.meta.url),
);

/**
 * browser/streaming.js imports the wasm-bindgen build, which Node tests do
 * not build, and which works only once the browser entry has initialised it.
 * Its adapters only call the one-shot functions, which the native addon
 * provides with the same behaviour. Other importers of the build, such as the
 * browser entry that wasm.spec.ts loads, get the real one, but the adapters
 * that the entry re-exports still run on the stub.
 */
function wasmBindgenStub(): Plugin {
  return {
    name: 'comprs:wasm-bindgen-stub',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source !== './comprs-wasm.js' || importer === undefined) {
        return null;
      }
      return normalizePath(importer) === STREAM_ADAPTERS ? WASM_BINDGEN_STUB : null;
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [wasmBindgenStub()],
  test: {
    include: ['__test__/**/*.spec.ts'],
    exclude: ['node_modules', 'target', '.claude'],
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
      include: ['streams.js', 'node.js'],
      thresholds: {
        lines: 70,
        functions: 80,
        branches: 60,
      },
    },
  },
}));
