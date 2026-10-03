// Browser entry point (the `browser` condition of the package exports): the
// wasm-bindgen build, with its streaming contexts replaced by JS-side adapters
// that wrap the one-shot APIs, to work around WebAssembly.Memory growth
// invalidating ArrayBuffer views.
// See: https://github.com/derodero24/comprs/issues/106
//
// The WebAssembly module is fetched and instantiated here, with top-level
// await, so every export works as soon as the import resolves. As require()
// cannot load this module, the package exports it to imports only. webpack 5
// and Vite emit the file that `new URL('…', import.meta.url)` names as an
// asset; with other bundlers, it has to be copied next to the bundle (see
// Browser Usage in the README). This module must stay listed under
// `sideEffects` in both package.json files, so that bundlers keep this
// initialisation when they tree-shake the re-exports.

import init from './comprs-wasm.js';

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

// One-shot APIs (pass through from WASM)
export {
  brotliCompress,
  brotliCompressWithDict,
  brotliDecompress,
  brotliDecompressWithCapacity,
  brotliDecompressWithDict,
  brotliDecompressWithDictWithCapacity,
  crc32,
  decompress,
  deflateCompress,
  deflateDecompress,
  deflateDecompressWithCapacity,
  detectFormat,
  gzipCompress,
  gzipCompressWithHeader,
  gzipDecompress,
  gzipDecompressWithCapacity,
  gzipReadHeader,
  lz4Compress,
  lz4Decompress,
  lz4DecompressWithCapacity,
  version,
  zstdCompress,
  zstdCompressWithDict,
  zstdDecompress,
  zstdDecompressWithCapacity,
  zstdDecompressWithDict,
  zstdDecompressWithDictWithCapacity,
  zstdTrainDictionary,
} from './comprs-wasm.js';

// Streaming context adapters (override native WASM contexts)
export {
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
} from './streaming.js';
