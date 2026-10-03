// Browser entry point (the `browser` condition of the package exports): the
// wasm-bindgen build, with *Async variants of its one-shot functions.
//
// The WebAssembly module is fetched and instantiated here, with top-level
// await, so every export works as soon as the import resolves. As require()
// cannot load this module, the package exports it to imports only. webpack 5
// and Vite emit the file that `new URL('…', import.meta.url)` names as an
// asset; with other bundlers, it has to be copied next to the bundle (see
// Browser Usage in the README). This module must stay listed under
// `sideEffects` in both package.json files, so that bundlers keep this
// initialisation when they tree-shake the re-exports.

import init, {
  brotliCompress,
  brotliCompressWithDict,
  brotliDecompress,
  brotliDecompressWithCapacity,
  brotliDecompressWithDict,
  brotliDecompressWithDictWithCapacity,
  decompress,
  deflateCompress,
  deflateDecompress,
  deflateDecompressWithCapacity,
  gzipCompress,
  gzipDecompress,
  gzipDecompressWithCapacity,
  lz4Compress,
  lz4Decompress,
  lz4DecompressWithCapacity,
  zstdCompress,
  zstdCompressWithDict,
  zstdDecompress,
  zstdDecompressWithCapacity,
  zstdDecompressWithDict,
  zstdDecompressWithDictWithCapacity,
  zstdTrainDictionary,
} from './comprs-wasm.js';

const wasmUrl = new URL('./comprs-wasm_bg.wasm', import.meta.url);
try {
  await init({ module_or_path: wasmUrl });
} catch (cause) {
  throw new Error(
    `comprs could not load its WebAssembly module from ${wasmUrl}. See ` +
      'https://github.com/derodero24/comprs#browser-usage for what each bundler needs.',
    { cause },
  );
}

// The functions and stream contexts as wasm-bindgen generates them. The
// contexts copy each chunk into WebAssembly memory before transform()
// returns, as the native ones copy it, and add the free() and
// [Symbol.dispose]() methods of the glue, which release that memory without
// waiting for garbage collection.
export {
  BrotliCompressContext,
  BrotliCompressDictContext,
  BrotliDecompressContext,
  BrotliDecompressDictContext,
  brotliCompress,
  brotliCompressWithDict,
  brotliDecompress,
  brotliDecompressWithCapacity,
  brotliDecompressWithDict,
  brotliDecompressWithDictWithCapacity,
  crc32,
  DeflateCompressContext,
  DeflateDecompressContext,
  decompress,
  deflateCompress,
  deflateDecompress,
  deflateDecompressWithCapacity,
  detectFormat,
  GzipCompressContext,
  GzipDecompressContext,
  gzipCompress,
  gzipCompressWithHeader,
  gzipDecompress,
  gzipDecompressWithCapacity,
  gzipReadHeader,
  Lz4CompressContext,
  Lz4DecompressContext,
  lz4Compress,
  lz4Decompress,
  lz4DecompressWithCapacity,
  version,
  ZstdCompressContext,
  ZstdCompressDictContext,
  ZstdDecompressContext,
  ZstdDecompressDictContext,
  zstdCompress,
  zstdCompressWithDict,
  zstdDecompress,
  zstdDecompressWithCapacity,
  zstdDecompressWithDict,
  zstdDecompressWithDictWithCapacity,
  zstdTrainDictionary,
} from './comprs-wasm.js';

// The *Async functions, for code that also runs on the native addon, which
// runs them on the libuv thread pool. There is no such pool here: they call
// the synchronous function on the calling thread before they return, and
// return a Promise of its result. Like async functions, they report every
// error by rejecting that Promise, never by throwing.

/** Call `fn` now, and return a Promise of what it returns or throws. */
function settle(fn) {
  return new Promise((resolve) => resolve(fn()));
}

export function zstdCompressAsync(data, level) {
  return settle(() => zstdCompress(data, level));
}

export function zstdDecompressAsync(data) {
  return settle(() => zstdDecompress(data));
}

export function zstdDecompressWithCapacityAsync(data, capacity) {
  return settle(() => zstdDecompressWithCapacity(data, capacity));
}

export function zstdCompressWithDictAsync(data, dict, level) {
  return settle(() => zstdCompressWithDict(data, dict, level));
}

export function zstdDecompressWithDictAsync(data, dict) {
  return settle(() => zstdDecompressWithDict(data, dict));
}

export function zstdDecompressWithDictWithCapacityAsync(data, dict, capacity) {
  return settle(() => zstdDecompressWithDictWithCapacity(data, dict, capacity));
}

export function zstdTrainDictionaryAsync(samples, maxDictSize) {
  return settle(() => zstdTrainDictionary(samples, maxDictSize));
}

export function gzipCompressAsync(data, level) {
  return settle(() => gzipCompress(data, level));
}

export function gzipDecompressAsync(data) {
  return settle(() => gzipDecompress(data));
}

export function gzipDecompressWithCapacityAsync(data, capacity) {
  return settle(() => gzipDecompressWithCapacity(data, capacity));
}

export function deflateCompressAsync(data, level) {
  return settle(() => deflateCompress(data, level));
}

export function deflateDecompressAsync(data) {
  return settle(() => deflateDecompress(data));
}

export function deflateDecompressWithCapacityAsync(data, capacity) {
  return settle(() => deflateDecompressWithCapacity(data, capacity));
}

export function brotliCompressAsync(data, quality) {
  return settle(() => brotliCompress(data, quality));
}

export function brotliDecompressAsync(data) {
  return settle(() => brotliDecompress(data));
}

export function brotliDecompressWithCapacityAsync(data, capacity) {
  return settle(() => brotliDecompressWithCapacity(data, capacity));
}

export function brotliCompressWithDictAsync(data, dict, quality) {
  return settle(() => brotliCompressWithDict(data, dict, quality));
}

export function brotliDecompressWithDictAsync(data, dict) {
  return settle(() => brotliDecompressWithDict(data, dict));
}

export function brotliDecompressWithDictWithCapacityAsync(data, dict, capacity) {
  return settle(() => brotliDecompressWithDictWithCapacity(data, dict, capacity));
}

export function lz4CompressAsync(data) {
  return settle(() => lz4Compress(data));
}

export function lz4DecompressAsync(data) {
  return settle(() => lz4Decompress(data));
}

export function lz4DecompressWithCapacityAsync(data, capacity) {
  return settle(() => lz4DecompressWithCapacity(data, capacity));
}

export function decompressAsync(data) {
  return settle(() => decompress(data));
}
