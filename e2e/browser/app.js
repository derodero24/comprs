// The browser application that every bundler fixture builds: it imports
// @derodero24/comprs and its ./streams subpath by name, which resolve to the
// WebAssembly build through the `browser` condition of the package exports,
// and runs the checks of ../scenario.js. The outcome goes to the
// `data-result` attribute of <html>, where browser.spec.ts reads it:
// `passed`, or the error that the checks threw.
//
// The functions imported here, and the stream contexts behind ./streams,
// are those of the wasm-bindgen glue, which the entry re-exports once it
// has initialised the WebAssembly module. The *Async functions, which the
// entry defines itself, are imported later, on their own: until then, only
// the side effects of the entry keep its initialisation in the bundle, and
// a bundler that drops it, as "sideEffects": false let bundlers do in
// 2.0.2, makes the first check fail.

import {
  brotliCompress,
  brotliDecompress,
  CompressionFormat,
  crc32,
  decompress,
  deflateCompress,
  deflateDecompress,
  detectFormat,
  gzipCompress,
  gzipDecompress,
  lz4Compress,
  lz4Decompress,
  version,
  zstdCompress,
  zstdDecompress,
} from '@derodero24/comprs';
import { createDecompressStream, createZstdCompressStream } from '@derodero24/comprs/streams';
import { checkPackage } from '../scenario.js';

let result = 'passed';
try {
  await checkPackage({
    zstdCompress,
    zstdDecompress,
    gzipCompress,
    gzipDecompress,
    deflateCompress,
    deflateDecompress,
    brotliCompress,
    brotliDecompress,
    lz4Compress,
    lz4Decompress,
    decompress,
    detectFormat,
    CompressionFormat,
    crc32,
    version,
    createZstdCompressStream,
    createDecompressStream,
    importAsync: () => import('@derodero24/comprs'),
  });
} catch (error) {
  result = error instanceof Error ? (error.stack ?? error.message) : String(error);
}
document.documentElement.dataset['result'] = result;
