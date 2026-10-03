import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// Use local WASM build when available (after `pnpm run build:wasm-bindgen` in repo root).
// On GitHub Pages CI, WASM is built before this runs. In development without a
// local WASM build, falls back to a JS mock so the UI can be previewed.
const wasmBgFile = fileURLToPath(new URL('../browser/comprs-wasm_bg.wasm', import.meta.url));
const hasLocalWasm = existsSync(wasmBgFile);
const mockEntry = fileURLToPath(new URL('./comprs-mock.js', import.meta.url));

// The package's browser entry, which loads the WASM binary next to it.
const browserEntry = fileURLToPath(new URL('../browser/index.js', import.meta.url));

export default defineConfig({
  base: process.env.GITHUB_ACTIONS ? '/comprs/' : '/',
  build: {
    // WASM entry uses top-level await (requires es2022+)
    target: 'es2022',
  },
  server: {
    // Allow serving WASM files from parent directory during local development
    // (the browser build lives in the repo's browser/ dir, outside the playground dir)
    fs: hasLocalWasm ? { allow: ['..'] } : {},
  },
  resolve: {
    alias: hasLocalWasm
      ? {
          // Real WASM: the browser entry of the local build
          '@derodero24/comprs': browserEntry,
        }
      : {
          // Dev mock: bypass WASM entirely with a JS fallback
          '@derodero24/comprs': mockEntry,
        },
  },
});
