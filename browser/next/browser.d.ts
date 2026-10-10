import './wasm.js';
export type { Bytes, CompressOptions, DecompressOptions, ErrorCode, Format, GzipHeaderOptions, Input, TrainDictionaryOptions, } from './api.js';
export { compress, compressSync, decompress, decompressSync, detectFormat, trainDictionary, trainDictionarySync, } from './api.js';
