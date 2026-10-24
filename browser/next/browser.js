// The entry point of @derodero24/comprs/next for browsers: the functions of
// api.ts, with the full WebAssembly build as their backend for every
// format, once ../wasm.js has loaded it with top-level await, as for the
// browser entry of the package. It exports what the entry point for
// Node.js, index.ts, exports.
import * as glue from '../wasm.js';
import { FORMATS } from './api.js';
import { registerBackend } from './backend.js';
import { wasmBackend } from './wasm.js';
registerBackend(wasmBackend(glue, FORMATS), FORMATS);
export { CompressionStream, compress, compressSync, DecompressionStream, Dictionary, decompress, decompressSync, detectFormat, trainDictionary, trainDictionarySync, } from './api.js';
