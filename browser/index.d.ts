// Types of the browser entry point (index.js), which exports the functions
// and stream contexts of the wasm-bindgen build (crates/wasm), *Async
// variants of its one-shot functions, and the CompressionFormat enum.
//
// They take the arguments of the native declarations in ../index.d.ts, but
// results are Uint8Array rather than Buffer, and the stream contexts also
// have the free() method of the glue. __test__/wasm-parity.spec.ts checks
// them against the native declarations.
// They are written by hand rather than re-exported from the generated
// comprs-wasm.d.ts, which has no *Async functions, declares the init
// functions that the entry calls itself, and needs the DOM library.

// biome-ignore lint/complexity/noUselessEmptyExport: in a declaration file, it limits the exports to the declarations marked `export`, leaving out the base classes of the stream contexts.
export {};

// -- zstd --

/**
 * Compress data with zstd. `level` ranges from -131072 to 22 (default 3);
 * negative levels select fast mode, and 0 is the default level.
 */
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

/**
 * Compression format that detectFormat() returns. Compare a result with the
 * members, such as `CompressionFormat.Zstd`, or with their values, the
 * strings `'zstd'`, `'gzip'`, `'brotli'`, `'lz4'` and `'unknown'`. The
 * members of the runtime object are not enumerable (`Object.keys()` and
 * `Object.values()` return `[]`), so use them by name.
 */
export declare enum CompressionFormat {
  Zstd = 'zstd',
  Gzip = 'gzip',
  Brotli = 'brotli',
  Lz4 = 'lz4',
  Unknown = 'unknown',
}

/** Detect the compression format of data from its magic bytes. */
export declare function detectFormat(data: Uint8Array): CompressionFormat;
/**
 * Decompress data in any format that detectFormat() recognises, failing if
 * the output exceeds `maxOutputSize` bytes (default 256 MiB).
 */
export declare function decompress(data: Uint8Array, maxOutputSize?: number | null): Uint8Array;
/** Compute the CRC32 of data, continuing from `initialValue` if given. */
export declare function crc32(data: Uint8Array, initialValue?: number | null): number;
/** Version of comprs. */
export declare function version(): string;

// -- *Async variants --
//
// For code that also runs on the native addon, which runs them on the libuv
// thread pool. Here, each one runs its synchronous function on the calling
// thread before it returns, so the thread is busy just as long, and returns
// a Promise of the result. Every error rejects that Promise; none is thrown.

/** Run zstdCompress() on the calling thread, and return a Promise of its result. */
export declare function zstdCompressAsync(
  data: Uint8Array,
  level?: number | null,
): Promise<Uint8Array>;
/** Run zstdDecompress() on the calling thread, and return a Promise of its result. */
export declare function zstdDecompressAsync(data: Uint8Array): Promise<Uint8Array>;
/** Run zstdDecompressWithCapacity() on the calling thread, and return a Promise of its result. */
export declare function zstdDecompressWithCapacityAsync(
  data: Uint8Array,
  capacity: number,
): Promise<Uint8Array>;
/** Run zstdCompressWithDict() on the calling thread, and return a Promise of its result. */
export declare function zstdCompressWithDictAsync(
  data: Uint8Array,
  dict: Uint8Array,
  level?: number | null,
): Promise<Uint8Array>;
/** Run zstdDecompressWithDict() on the calling thread, and return a Promise of its result. */
export declare function zstdDecompressWithDictAsync(
  data: Uint8Array,
  dict: Uint8Array,
): Promise<Uint8Array>;
/**
 * Run zstdDecompressWithDictWithCapacity() on the calling thread, and return a
 * Promise of its result.
 */
export declare function zstdDecompressWithDictWithCapacityAsync(
  data: Uint8Array,
  dict: Uint8Array,
  capacity: number,
): Promise<Uint8Array>;
/** Run zstdTrainDictionary() on the calling thread, and return a Promise of its result. */
export declare function zstdTrainDictionaryAsync(
  samples: Uint8Array[],
  maxDictSize?: number | null,
): Promise<Uint8Array>;
/** Run gzipCompress() on the calling thread, and return a Promise of its result. */
export declare function gzipCompressAsync(
  data: Uint8Array,
  level?: number | null,
): Promise<Uint8Array>;
/** Run gzipDecompress() on the calling thread, and return a Promise of its result. */
export declare function gzipDecompressAsync(data: Uint8Array): Promise<Uint8Array>;
/** Run gzipDecompressWithCapacity() on the calling thread, and return a Promise of its result. */
export declare function gzipDecompressWithCapacityAsync(
  data: Uint8Array,
  capacity: number,
): Promise<Uint8Array>;
/** Run deflateCompress() on the calling thread, and return a Promise of its result. */
export declare function deflateCompressAsync(
  data: Uint8Array,
  level?: number | null,
): Promise<Uint8Array>;
/** Run deflateDecompress() on the calling thread, and return a Promise of its result. */
export declare function deflateDecompressAsync(data: Uint8Array): Promise<Uint8Array>;
/**
 * Run deflateDecompressWithCapacity() on the calling thread, and return a
 * Promise of its result.
 */
export declare function deflateDecompressWithCapacityAsync(
  data: Uint8Array,
  capacity: number,
): Promise<Uint8Array>;
/** Run brotliCompress() on the calling thread, and return a Promise of its result. */
export declare function brotliCompressAsync(
  data: Uint8Array,
  quality?: number | null,
): Promise<Uint8Array>;
/** Run brotliDecompress() on the calling thread, and return a Promise of its result. */
export declare function brotliDecompressAsync(data: Uint8Array): Promise<Uint8Array>;
/**
 * Run brotliDecompressWithCapacity() on the calling thread, and return a
 * Promise of its result.
 */
export declare function brotliDecompressWithCapacityAsync(
  data: Uint8Array,
  capacity: number,
): Promise<Uint8Array>;
/** Run brotliCompressWithDict() on the calling thread, and return a Promise of its result. */
export declare function brotliCompressWithDictAsync(
  data: Uint8Array,
  dict: Uint8Array,
  quality?: number | null,
): Promise<Uint8Array>;
/** Run brotliDecompressWithDict() on the calling thread, and return a Promise of its result. */
export declare function brotliDecompressWithDictAsync(
  data: Uint8Array,
  dict: Uint8Array,
): Promise<Uint8Array>;
/**
 * Run brotliDecompressWithDictWithCapacity() on the calling thread, and return
 * a Promise of its result.
 */
export declare function brotliDecompressWithDictWithCapacityAsync(
  data: Uint8Array,
  dict: Uint8Array,
  capacity: number,
): Promise<Uint8Array>;
/** Run lz4Compress() on the calling thread, and return a Promise of its result. */
export declare function lz4CompressAsync(data: Uint8Array): Promise<Uint8Array>;
/** Run lz4Decompress() on the calling thread, and return a Promise of its result. */
export declare function lz4DecompressAsync(data: Uint8Array): Promise<Uint8Array>;
/** Run lz4DecompressWithCapacity() on the calling thread, and return a Promise of its result. */
export declare function lz4DecompressWithCapacityAsync(
  data: Uint8Array,
  capacity: number,
): Promise<Uint8Array>;
/** Run decompress() on the calling thread, and return a Promise of its result. */
export declare function decompressAsync(
  data: Uint8Array,
  maxOutputSize?: number | null,
): Promise<Uint8Array>;

// -- Streaming contexts --
//
// The classes that wasm-bindgen generates, which copy each chunk into
// WebAssembly memory before transform() returns and keep their state there.

/** `Symbol.dispose`, if the TypeScript library declares it. */
type DisposeSymbol = SymbolConstructor extends {
  readonly dispose: infer Key extends symbol;
}
  ? Key
  : never;

/**
 * The `[Symbol.dispose]()` method, which the entry defines where the runtime
 * has `Symbol.dispose`. It is declared only where the TypeScript library has
 * it too, so that these declarations also type-check without it.
 */
type Disposal = { [Key in DisposeSymbol]: () => void };

/** A base class with the `[Symbol.dispose]()` method. */
interface DisposableContext extends Disposal {}
declare const DisposableContext: new () => DisposableContext;

declare class StreamContext extends DisposableContext {
  /** Compress or decompress a chunk, and return the output that is ready, if any. */
  transform(chunk: Uint8Array): Uint8Array;
  /** Flush the internal buffers, and return the output they held. */
  flush(): Uint8Array;
  /**
   * End the stream, and return the rest of the output. Decompression throws
   * if the input ended before the compressed stream did.
   */
  finish(): Uint8Array;
  /**
   * Release the codec state of the context now, for a stream that will not
   * be finished. Later calls throw; `finish()` releases the state too, and
   * closing a finished or closed context does nothing.
   * `[Symbol.dispose]()` is the same method, for `using` declarations.
   */
  close(): void;
  /**
   * Free the context itself as well as its state, rather than leave the
   * object to garbage collection. Any later call of a method throws.
   */
  free(): void;
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

/**
 * Decodes the buffered input in flush(), which throws if no input was
 * transformed; finish() also decodes what is left, then ends the stream.
 */
export declare class Lz4DecompressContext extends StreamContext {
  constructor(maxOutputSize?: number | null);
}
