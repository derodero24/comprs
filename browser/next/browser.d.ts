import './wasm.js';
export type { AbortOptions, AbortSignalLike, Bytes, CompressionStreamOptions, CompressOptions, DecompressionStreamOptions, DecompressOptions, DictionaryOptions, ErrorCode, Format, GzipHeaderOptions, Input, TrainDictionaryOptions, } from './api.js';
export { CompressionStream, compress, compressSync, DecompressionStream, Dictionary, decompress, decompressSync, detectFormat, trainDictionary, trainDictionarySync, } from './api.js';
