/**
 * WASM loader for the playground.
 *
 * Vite 8 does not support the TC39 WebAssembly ESM integration proposal
 * (import * as wasm from './file.wasm'), so we cannot use comprs-wasm.js
 * directly. Instead, import the background bindings and instantiate the
 * WASM binary manually.
 *
 * This follows the same pattern used in rapid-fuzzy's e2e tests.
 */

// Import background bindings (no .wasm imports)
import * as mod from '../comprs-wasm_bg.js';

// Use Vite's ?url import to get a resolved URL for the WASM binary
import wasmUrl from '../comprs-wasm_bg.wasm?url';

const bytes = await fetch(wasmUrl).then((r) => r.arrayBuffer());
const { instance } = await WebAssembly.instantiate(bytes, {
  './comprs-wasm_bg.js': mod,
});
mod.__wbg_set_wasm(instance.exports);

// Re-export only the functions used by the playground
export const {
  brotliCompress,
  brotliDecompress,
  gzipCompress,
  gzipDecompress,
  lz4Compress,
  lz4Decompress,
  zstdCompress,
  zstdDecompress,
} = mod;
