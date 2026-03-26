import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// Use local WASM build when available (after `pnpm run build:wasm` in repo root).
// On GitHub Pages CI, WASM is built before this runs. In development without a
// local WASM build, falls back to a JS mock so the UI can be previewed.
const localWasmEntry = fileURLToPath(new URL('../comprs.wasi-browser.js', import.meta.url));
const hasLocalWasm = existsSync(localWasmEntry);
const mockEntry = fileURLToPath(new URL('./comprs-mock.js', import.meta.url));
const browserEntry = fileURLToPath(new URL('../browser-entry.js', import.meta.url));

const corsHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  base: process.env.GITHUB_ACTIONS ? '/comprs/' : '/',
  build: {
    // WASM entry uses top-level await (requires es2022+)
    target: 'es2022',
  },
  server: {
    headers: corsHeaders,
    // Allow serving WASM files from parent directory during local development
    // (comprs.wasm32-wasi.wasm lives in repo root, outside the playground dir)
    fs: hasLocalWasm ? { allow: ['..'] } : {},
  },
  preview: {
    headers: corsHeaders,
  },
  resolve: {
    alias: hasLocalWasm
      ? {
          // Real WASM: point comprs to browser entry + use local WASM build
          comprs: browserEntry,
          'comprs-wasm32-wasi': localWasmEntry,
        }
      : {
          // Dev mock: bypass WASM entirely with a JS fallback
          comprs: mockEntry,
        },
  },
});
