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
// functions that wasm.js calls, and needs the DOM library.

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
  /**
   * `transform(chunk)`, which returns a Promise of the output, and reports
   * every error, an invalid argument included, by rejecting it. The native
   * addon runs it on the libuv thread pool; this build runs it
   * synchronously, on the calling thread, before it returns.
   *
   * At most one asynchronous call may be in flight per context: in the
   * native addon, until its Promise settles, another asynchronous call
   * rejects and a synchronous call throws "<name> is busy: an asynchronous
   * call has not finished", such as "zstd stream is busy: an asynchronous
   * call has not finished". After `close()`, calls reject with "<name>
   * already closed".
   */
  transformAsync(chunk: Uint8Array): Promise<Uint8Array>;
  /**
   * `flush()`, which returns a Promise of the output, and reports every
   * error by rejecting it. The native addon runs it on the libuv thread
   * pool; this build runs it synchronously, on the calling thread, before it
   * returns. At most one asynchronous call may be in flight per context, as
   * for `transformAsync()`. After `close()`, calls reject with "<name>
   * already closed".
   */
  flushAsync(): Promise<Uint8Array>;
  /**
   * `finish()`, which returns a Promise of the rest of the output, and
   * reports every error by rejecting it. The native addon runs it on the
   * libuv thread pool; this build runs it synchronously, on the calling
   * thread, before it returns. At most one asynchronous call may be in
   * flight per context, as for `transformAsync()`. After `close()`, calls
   * reject with "<name> already closed".
   */
  finishAsync(): Promise<Uint8Array>;
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

/**
 * Options of a stream context, as the native declarations define them.
 *
 * `Lz4DecompressContext` and `BrotliCompressDictContext` take them.
 */
export interface StreamContextOptions {
  /**
   * Process the input as it arrives rather than hold it. With
   * `incremental: true`, `Lz4DecompressContext.transform()` returns each LZ4
   * block once all of it has arrived, `flush()` returns nothing more, and
   * `maxOutputSize` limits the output of the whole stream;
   * `BrotliCompressDictContext` holds at most the first 4 MiB less 16 bytes
   * of input (4,194,288 bytes), then compresses each chunk as it arrives,
   * without the dictionary. Without it, the context keeps the behaviour that
   * it has always had. The stream helpers of `@derodero24/comprs/streams`
   * set it.
   */
  incremental?: boolean | undefined;
}

/**
 * Streaming brotli compression context with custom dictionary, in one of two
 * modes. By default, it buffers its input: transform() and flush() return an
 * empty array, and finish() compresses all of the input, into the output of
 * brotliCompressWithDict(). With `{ incremental: true }`, it holds at most
 * the first 4 MiB less 16 bytes of input (4,194,288 bytes), which compress
 * with the dictionary into the output of brotliCompressWithDict() if the
 * input ends there. A longer input is compressed without the dictionary,
 * which only helps the start of a stream, into a stream that decodes with or
 * without it: the transform() that takes the input past those bytes returns
 * their output, and from then on transform() returns the output that is
 * ready, flush() all the output of the input so far, and finish() the rest
 * of the stream.
 */
export declare class BrotliCompressDictContext extends StreamContext {
  constructor(dict: Uint8Array, quality?: number | null, options?: StreamContextOptions | null);
  /**
   * By default, keep `chunk` and return an empty array. Incremental, return
   * the output that is ready, which is empty while the context holds its
   * input.
   */
  transform(chunk: Uint8Array): Uint8Array;
  /**
   * Return an empty array while the context holds its input, as it always
   * does by default. Incremental, once the input has passed the first
   * 4,194,288 bytes, return all the output of the input so far.
   */
  flush(): Uint8Array;
  /**
   * End the stream, and return the rest of the output: all of it, from the
   * input that the context holds, if it holds the input.
   */
  finish(): Uint8Array;
}

export declare class BrotliDecompressDictContext extends StreamContext {
  constructor(dict: Uint8Array, maxOutputSize?: number | null);
}

export declare class Lz4CompressContext extends StreamContext {
  constructor();
}

/**
 * Streaming LZ4 frame decompression context, in one of two modes. By
 * default, it buffers its input: transform() returns an empty array, and
 * flush() decodes what has been buffered since the last flush(), with
 * `maxOutputSize` applying to each flush() on its own; flush() throws if no
 * input was transformed, and finish() decodes what is left, then ends the
 * stream. With `{ incremental: true }`, it decodes its input as it arrives,
 * and keeps at most one block of it: transform() returns each block once
 * all of the block has arrived, flush() returns an empty array, finish()
 * throws unless the input ended between frames, and `maxOutputSize` limits
 * the output of the whole stream.
 */
export declare class Lz4DecompressContext extends StreamContext {
  constructor(maxOutputSize?: number | null, options?: StreamContextOptions | null);
  /**
   * By default, keep `chunk` and return an empty array. Incremental, return
   * the content of the blocks that `chunk` completes, and throw if the
   * input is invalid or the output exceeds `maxOutputSize`.
   */
  transform(chunk: Uint8Array): Uint8Array;
  /**
   * By default, decode the input buffered since the last flush(), which must
   * end between frames. Incremental, return an empty array.
   */
  flush(): Uint8Array;
  /**
   * End the stream. By default, decode what is left, like flush().
   * Incremental, return an empty array, or throw unless the input ended
   * between frames.
   */
  finish(): Uint8Array;
}
