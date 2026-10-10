import './wasm.js';
export type { Bytes, CompressOptions, DecompressOptions, DictionaryOptions, ErrorCode, Format, GzipHeaderOptions, Input, TrainDictionaryOptions, } from './api.js';
export { compress, compressSync, Dictionary, decompress, decompressSync, detectFormat, trainDictionary, trainDictionarySync, } from './api.js';
