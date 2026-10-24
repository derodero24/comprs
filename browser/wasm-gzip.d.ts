// Declarations of wasm-gzip.js, which exports what wasm.js exports, for the
// gzip build of the WebAssembly module.
export {
  NextCompressContext,
  NextDecompressContext,
  NextDictionary,
  nextCompress,
  nextDecompress,
  nextDetectFormat,
  nextDetectPrefix,
  nextTrainDictionary,
} from './wasm.js';
