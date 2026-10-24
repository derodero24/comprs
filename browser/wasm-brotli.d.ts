// Declarations of wasm-brotli.js, which exports what wasm.js exports, for the
// brotli build of the WebAssembly module.
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
