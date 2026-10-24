// Declarations of wasm-zstd.js, which exports what wasm.js exports, for the
// zstd build of the WebAssembly module.
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
