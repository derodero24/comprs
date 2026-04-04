import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// Use local WASM build when available (after `pnpm run build:wasm-bindgen` in repo root).
// On GitHub Pages CI, WASM is built before this runs. In development without a
// local WASM build, falls back to a JS mock so the UI can be previewed.
const wasmBgFile = fileURLToPath(new URL('../comprs-wasm_bg.wasm', import.meta.url));
const hasLocalWasm = existsSync(wasmBgFile);
const mockEntry = fileURLToPath(new URL('./comprs-mock.js', import.meta.url));

// Use the playground's wasm-loader.js which manually instantiates the WASM binary.
// This bypasses the ESM WASM import that Vite 8 does not support.
const wasmLoader = fileURLToPath(new URL('./wasm-loader.js', import.meta.url));

export default defineConfig({
  base: process.env.GITHUB_ACTIONS ? '/comprs/' : '/',
  build: {
    // WASM entry uses top-level await (requires es2022+)
    target: 'es2022',
  },
  server: {
    // Allow serving WASM files from parent directory during local development
    // (comprs-wasm_bg.wasm lives in repo root, outside the playground dir)
    fs: hasLocalWasm ? { allow: ['..'] } : {},
  },
  resolve: {
    alias: hasLocalWasm
      ? {
          // Real WASM: use manual instantiation loader (Vite 8 ESM WASM workaround)
          '@derodero24/comprs': wasmLoader,
        }
      : {
          // Dev mock: bypass WASM entirely with a JS fallback
          '@derodero24/comprs': mockEntry,
        },
  },
});
