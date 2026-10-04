// Types of the browser entry point (index.js), which exports the functions of
// the wasm-bindgen build (crates/wasm) and the stream context adapters of
// streaming.js.
//
// They take the arguments of the native declarations in ../index.d.ts, but
// there are no *Async functions, results are Uint8Array rather than Buffer,
// and detectFormat() returns a plain string. __test__/wasm-parity.spec.ts
// checks them against the native declarations. They are written by hand
// rather than re-exported from the generated comprs-wasm.d.ts, which
// declares the wasm-bindgen classes that the adapters replace, needs the DOM
// library, and uses `any`.

// biome-ignore lint/complexity/noUselessEmptyExport: in a declaration file, it limits the exports to the declarations marked `export`, leaving out StreamContext.
export {};

// -- zstd --

/** Compress data with zstd. `level` ranges from 1 to 22 (default 3). */
export declare function zstdCompress(data: Uint8Array, level?: number | null): Uint8Array;
/** Decompress zstd-compressed data. */
export declare function zstdDecompress(data: Uint8Array): Uint8Array;
/** Decompress zstd-compressed data, failing if the output exceeds `capacity` bytes. */
export declare function zstdDecompressWithCapacity(data: Uint8Array, capacity: number): Uint8Array;
/** Train a zstd dictionary from sample data, of at most `maxDictSize` bytes. */
export declare function zstdTrainDictionary(
  samples: Uint8Array[],
  maxDictSize?: number | null,
): Uint8Array;
/** Compress data with zstd and a dictionary. */
export declare function zstdCompressWithDict(
  data: Uint8Array,
  dict: Uint8Array,
  level?: number | null,
): Uint8Array;
/** Decompress zstd-compressed data with the dictionary it was compressed with. */
export declare function zstdDecompressWithDict(data: Uint8Array, dict: Uint8Array): Uint8Array;
/** Decompress with a dictionary, failing if the output exceeds `capacity` bytes. */
export declare function zstdDecompressWithDictWithCapacity(
  data: Uint8Array,
  dict: Uint8Array,
  capacity: number,
): Uint8Array;

// -- gzip --

/** Header fields of a gzip member, as gzipReadHeader() returns them. */
export interface GzipHeader {
  /** Original file name, if the header has one. */
  filename?: string;
  /** Modification time as a Unix timestamp (seconds since epoch). */
  mtime: number;
  /** Comment, if the header has one. */
  comment?: string;
  /** Operating system that created the gzip member. */
  os: number;
  /** Extra field, if the header has one. */
  extra?: Uint8Array;
}

/** Header fields for gzipCompressWithHeader() to write. */
export interface GzipHeaderOptions {
  /** Original file name. */
  filename?: string;
  /** Modification time as a Unix timestamp (seconds since epoch). */
  mtime?: number;
}

/** Compress data with gzip. `level` ranges from 0 to 9 (default 6). */
export declare function gzipCompress(data: Uint8Array, level?: number | null): Uint8Array;
/** Decompress gzip-compressed data. */
export declare function gzipDecompress(data: Uint8Array): Uint8Array;
/** Decompress gzip-compressed data, failing if the output exceeds `capacity` bytes. */
export declare function gzipDecompressWithCapacity(data: Uint8Array, capacity: number): Uint8Array;
/** Compress data with gzip, with a file name and modification time in the header. */
export declare function gzipCompressWithHeader(
  data: Uint8Array,
  header: GzipHeaderOptions,
  level?: number | null,
): Uint8Array;
/** Read the header of a gzip member without decompressing it. */
export declare function gzipReadHeader(data: Uint8Array): GzipHeader;

// -- deflate (raw) --

/** Compress data with raw deflate. `level` ranges from 0 to 9 (default 6). */
export declare function deflateCompress(data: Uint8Array, level?: number | null): Uint8Array;
/** Decompress raw deflate data. */
export declare function deflateDecompress(data: Uint8Array): Uint8Array;
/** Decompress raw deflate data, failing if the output exceeds `capacity` bytes. */
export declare function deflateDecompressWithCapacity(
  data: Uint8Array,
  capacity: number,
): Uint8Array;

// -- brotli --

/** Compress data with brotli. `quality` ranges from 0 to 11 (default 6). */
export declare function brotliCompress(data: Uint8Array, quality?: number | null): Uint8Array;
/** Decompress brotli-compressed data. */
export declare function brotliDecompress(data: Uint8Array): Uint8Array;
/** Decompress brotli-compressed data, failing if the output exceeds `capacity` bytes. */
export declare function brotliDecompressWithCapacity(
  data: Uint8Array,
  capacity: number,
): Uint8Array;
/** Compress data with brotli and a custom dictionary. */
export declare function brotliCompressWithDict(
  data: Uint8Array,
  dict: Uint8Array,
  quality?: number | null,
): Uint8Array;
/** Decompress brotli-compressed data with the dictionary it was compressed with. */
export declare function brotliDecompressWithDict(data: Uint8Array, dict: Uint8Array): Uint8Array;
/** Decompress with a dictionary, failing if the output exceeds `capacity` bytes. */
export declare function brotliDecompressWithDictWithCapacity(
  data: Uint8Array,
  dict: Uint8Array,
  capacity: number,
): Uint8Array;

// -- lz4 --

/** Compress data in the LZ4 frame format. */
export declare function lz4Compress(data: Uint8Array): Uint8Array;
/** Decompress LZ4 frame data. */
export declare function lz4Decompress(data: Uint8Array): Uint8Array;
/** Decompress LZ4 frame data, failing if the output exceeds `capacity` bytes. */
export declare function lz4DecompressWithCapacity(data: Uint8Array, capacity: number): Uint8Array;

// -- Auto-detection and utilities --

/** Detect the compression format of data from its magic bytes. */
export declare function detectFormat(
  data: Uint8Array,
): 'zstd' | 'gzip' | 'brotli' | 'lz4' | 'unknown';
/**
 * Decompress data in any format that detectFormat() recognises, failing if
 * the output exceeds `maxOutputSize` bytes (default 256 MiB).
 */
export declare function decompress(data: Uint8Array, maxOutputSize?: number | null): Uint8Array;
/** Compute the CRC32 of data, continuing from `initialValue` if given. */
export declare function crc32(data: Uint8Array, initialValue?: number | null): number;
/** Version of comprs. */
export declare function version(): string;

// -- Streaming contexts --
//
// JS adapters rather than the wasm-bindgen classes: they buffer their input
// and run the one-shot function on finish(), or on flush() when they
// decompress brotli, zstd or lz4.

declare class StreamContext {
  transform(chunk: Uint8Array): Uint8Array;
  flush(): Uint8Array;
  finish(): Uint8Array;
}

export declare class ZstdCompressContext extends StreamContext {
  constructor(level?: number | null);
}

export declare class ZstdDecompressContext extends StreamContext {
  constructor(maxOutputSize?: number | null);
}

export declare class ZstdCompressDictContext extends StreamContext {
  constructor(dict: Uint8Array, level?: number | null);
}

export declare class ZstdDecompressDictContext extends StreamContext {
  constructor(dict: Uint8Array, maxOutputSize?: number | null);
}

export declare class GzipCompressContext extends StreamContext {
  constructor(level?: number | null);
}

export declare class GzipDecompressContext extends StreamContext {
  constructor(maxOutputSize?: number | null);
}

export declare class DeflateCompressContext extends StreamContext {
  constructor(level?: number | null);
}

export declare class DeflateDecompressContext extends StreamContext {
  constructor(maxOutputSize?: number | null);
}

export declare class BrotliCompressContext extends StreamContext {
  constructor(quality?: number | null);
}

export declare class BrotliDecompressContext extends StreamContext {
  constructor(maxOutputSize?: number | null);
}

export declare class BrotliCompressDictContext extends StreamContext {
  constructor(dict: Uint8Array, quality?: number | null);
}

export declare class BrotliDecompressDictContext extends StreamContext {
  constructor(dict: Uint8Array, maxOutputSize?: number | null);
}

export declare class Lz4CompressContext extends StreamContext {
  constructor();
}

/** Decompresses on flush(), and has no finish(). */
export declare class Lz4DecompressContext {
  constructor(maxOutputSize?: number | null);
  transform(chunk: Uint8Array): Uint8Array;
  flush(): Uint8Array;
}
