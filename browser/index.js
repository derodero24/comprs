// Browser entry point (the `browser` condition of the package exports): the
// wasm-bindgen build.
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
