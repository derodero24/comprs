// Declarations of wasm-lz4.js, which exports what wasm.js exports, for the
// lz4 build of the WebAssembly module.
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
