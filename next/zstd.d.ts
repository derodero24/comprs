import { type AbortOptions, CompressionStream as AnyCompressionStream, DecompressionStream as AnyDecompressionStream, type Bytes, type CompressionStreamOptions, type CompressOptions, type DecompressionStreamOptions, type DecompressOptions, type Input } from './api.js';
/** The formats of the zstd family. */
type Formats = 'zstd';
export type { AbortOptions, AbortSignalLike, Bytes, CompressionStreamOptions, CompressOptions, DecompressionStreamOptions, DecompressOptions, DictionaryOptions, ErrorCode, Format, GzipHeaderOptions, Input, TrainDictionaryOptions, } from './api.js';
export { Dictionary, detectFormat, trainDictionary, trainDictionarySync } from './api.js';
/** {@link compressAny | compress}, for the formats of the zstd family. */
export declare const compress: (data: Input, options: CompressOptions<Formats> & AbortOptions) => Promise<Bytes>;
/** {@link compressSyncAny | compressSync}, for the formats of the zstd family. */
export declare const compressSync: (data: Input, options: CompressOptions<Formats>) => Bytes;
/** {@link decompressAny | decompress}, for the formats of the zstd family. */
export declare const decompress: (data: Input, options?: DecompressOptions<Formats> & AbortOptions) => Promise<Bytes>;
/** {@link decompressSyncAny | decompressSync}, for the formats of the zstd family. */
export declare const decompressSync: (data: Input, options?: DecompressOptions<Formats>) => Bytes;
/** {@link AnyCompressionStream | CompressionStream}, for the formats of the zstd family. */
export declare const CompressionStream: new (format: Formats, options?: CompressionStreamOptions) => AnyCompressionStream;
export type CompressionStream = AnyCompressionStream;
/** {@link AnyDecompressionStream | DecompressionStream}, for the formats of the zstd family. */
export declare const DecompressionStream: new (format: Formats | 'auto', options?: DecompressionStreamOptions) => AnyDecompressionStream;
export type DecompressionStream = AnyDecompressionStream;
