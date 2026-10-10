// The entry point of @derodero24/comprs/next for browsers: the functions of
// api.ts, with the WebAssembly build as their backend. ./wasm.js sets it
// once ../wasm.js has loaded the WebAssembly module with top-level await,
// as for the browser entry of the package. It exports what the entry point
// for Node.js, index.ts, exports.
import './wasm.js';
export { compress, compressSync, Dictionary, decompress, decompressSync, detectFormat, trainDictionary, trainDictionarySync, } from './api.js';
