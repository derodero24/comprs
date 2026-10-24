import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// The playground imports @derodero24/comprs as users do: the file:..
// dependency installs the package from the repository root with the files it
// would be published with, and Vite resolves its browser entry through the
// package exports. That entry loads the WebAssembly binary that
// `pnpm run build:wasm-bindgen` builds in the repository root. Run
// `pnpm install` here after building it, as the installed package holds the
// files that existed at install time, which a rebuild does not always update.
//
// COMPRS_PLAYGROUND_MOCK=1 substitutes fake compressors for the package, for
// UI work without the WebAssembly build. Without it, a missing binary fails
// the dev server and the build, so that the mock is never deployed.
const useMock = process.env.COMPRS_PLAYGROUND_MOCK === '1';
const mockEntry = fileURLToPath(new URL('./comprs-mock.js', import.meta.url));
const wasmBinary = fileURLToPath(
  new URL('./node_modules/@derodero24/comprs/browser/comprs-wasm_bg.wasm', import.meta.url),
);

export default defineConfig(({ isPreview }) => {
  if (!(useMock || isPreview || existsSync(wasmBinary))) {
    throw new Error(
      `The WebAssembly build of @derodero24/comprs is missing (${wasmBinary}). ` +
        'Run `pnpm run build:wasm-bindgen` in the repository root, then `pnpm install` ' +
        'in playground/, or set COMPRS_PLAYGROUND_MOCK=1 to work on the UI with fake compressors.',
    );
  }

  return {
    base: process.env.GITHUB_ACTIONS ? '/comprs/' : '/',
    resolve: {
      alias: useMock ? { '@derodero24/comprs': mockEntry } : {},
    },
    worker: {
      // The worker imports the browser entry, which uses top-level await.
      format: 'es',
    },
  };
});
