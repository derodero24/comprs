// Browser entry point (the `browser` condition of the package exports): the
// wasm-bindgen build, with *Async variants of its one-shot functions.
//
// wasm.js, imported first, fetches and instantiates the WebAssembly module
// with top-level await, so every export works as soon as the import of this
// module resolves. As require() cannot load this module, the package exports
// it to imports only. This module and wasm.js must stay listed under
// `sideEffects` in both package.json files, so that bundlers keep that
// initialisation and the [Symbol.dispose] methods set below when they
// tree-shake the re-exports.

import './wasm.js';
import {
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
  DeflateCompressContext,
  DeflateDecompressContext,
  decompress,
  deflateCompress,
  deflateDecompress,
  deflateDecompressWithCapacity,
  GzipCompressContext,
  GzipDecompressContext,
  gzipCompress,
  gzipDecompress,
  gzipDecompressWithCapacity,
  Lz4CompressContext,
  Lz4DecompressContext,
  lz4Compress,
  lz4Decompress,
  lz4DecompressWithCapacity,
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

// The glue makes [Symbol.dispose]() an alias of free(). As in the native
// addon, it closes the context instead, so that later calls throw
// "<format> stream already closed" rather than a glue error.
if (Symbol.dispose) {
  for (const Context of [
    BrotliCompressContext,
    BrotliCompressDictContext,
    BrotliDecompressContext,
    BrotliDecompressDictContext,
    DeflateCompressContext,
    DeflateDecompressContext,
    GzipCompressContext,
    GzipDecompressContext,
    Lz4CompressContext,
    Lz4DecompressContext,
    ZstdCompressContext,
    ZstdCompressDictContext,
    ZstdDecompressContext,
    ZstdDecompressDictContext,
  ]) {
    Context.prototype[Symbol.dispose] = Context.prototype.close;
  }
}

// The functions and stream contexts as wasm-bindgen generates them. The
// contexts copy each chunk into WebAssembly memory before transform()
// returns, as the native ones copy it. Like those, they have close(), which
// releases their codec state without waiting for garbage collection, and
// the glue adds free(), which frees the context object as well.
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

// The CompressionFormat enum of the native addon, whose members name the
// values that detectFormat() returns. napi-rs defines them read-only and
// not enumerable, and so does this object: enumerable members, as in a
// frozen object literal, would make Object.keys() and Object.values()
// differ between the builds, which __test__/wasm-parity.spec.ts checks.
export const CompressionFormat = Object.defineProperties(
  {},
  {
    Zstd: { value: 'zstd' },
    Gzip: { value: 'gzip' },
    Brotli: { value: 'brotli' },
    Lz4: { value: 'lz4' },
    Unknown: { value: 'unknown' },
  },
);

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

export function decompressAsync(data, maxOutputSize) {
  return settle(() => decompress(data, maxOutputSize));
}
