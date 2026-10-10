// The entry point of @derodero24/comprs/next for Node.js: the functions of
// api.ts, with the native addon as their backend. The names are re-exported
// one by one, which every CommonJS lexer recognizes (cjs-module-lexer of
// Node.js, Bun, Deno and bundlers), so that ES modules can import them.
import './native.js';

export type {
  Bytes,
  CompressOptions,
  DecompressOptions,
  ErrorCode,
  Format,
  GzipHeaderOptions,
  Input,
  TrainDictionaryOptions,
} from './api.js';
export {
  compress,
  compressSync,
  decompress,
  decompressSync,
  detectFormat,
  trainDictionary,
  trainDictionarySync,
} from './api.js';
