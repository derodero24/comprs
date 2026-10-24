// The entry point of @derodero24/comprs/next for Node.js: the functions of
// api.ts, with the native addon as their backend. The names are re-exported
// one by one, which every CommonJS lexer recognizes (cjs-module-lexer of
// Node.js, Bun, Deno and bundlers), so that ES modules can import them.
import './native.js';

export type {
  AbortOptions,
  AbortSignalLike,
  Bytes,
  CompressionStreamOptions,
  CompressOptions,
  DecompressionStreamOptions,
  DecompressOptions,
  DictionaryOptions,
  ErrorCode,
  Format,
  GzipHeaderOptions,
  Input,
  TrainDictionaryOptions,
} from './api.js';
export {
  CompressionStream,
  compress,
  compressSync,
  DecompressionStream,
  Dictionary,
  decompress,
  decompressSync,
  detectFormat,
  trainDictionary,
  trainDictionarySync,
} from './api.js';
