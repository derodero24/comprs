// Declarations of wasm.js: the functions and the classes of the wasm-bindgen
// glue that the browser backend of the unified API (src/next/wasm.ts)
// calls, with the types of the arguments that it passes. They take and
// return what the hidden binding of the native addon does (Backend in
// src/next/backend.ts), without the *Async functions, with the methods of
// NextDictionary in place of its dictionary handles, and with the classes
// NextCompressContext and NextDecompressContext for its streams;
// crates/wasm/src/next.rs defines them.

/** A format of the unified API: Format in src/next/api.ts. */
export type Format = 'zstd' | 'gzip' | 'deflate' | 'deflate-raw' | 'brotli' | 'lz4';

/** The results, each in an ArrayBuffer of its own: Bytes in src/next/api.ts. */
export type Bytes = ReturnType<Uint8Array['slice']>;

/** A prepared dictionary: what the Dictionary class of src/next/api.ts holds. */
export declare class NextDictionary {
  constructor(bytes: Uint8Array, format: 'zstd' | 'brotli', level: number | undefined);
  /** nextCompress() with this dictionary in place of the bytes of one. */
  compress(
    data: Uint8Array,
    format: Format,
    level: number | undefined,
    gzipHeader: boolean | undefined,
    gzipFilename: string | undefined,
    gzipMtime: number | undefined,
    workers: number | undefined,
  ): Bytes;
  /** nextDecompress() with this dictionary in place of the bytes of one. */
  decompress(
    data: Uint8Array,
    format: Format | undefined,
    maxOutputSize: number | undefined,
  ): Bytes;
  /** A copy of the bytes of the dictionary. */
  toBytes(): Bytes;
  /** A NextCompressContext with this dictionary in place of the bytes of one. */
  compressContext(
    format: Format,
    level: number | undefined,
    gzipHeader: boolean | undefined,
    gzipFilename: string | undefined,
    gzipMtime: number | undefined,
    workers: number | undefined,
  ): NextCompressContext;
  /** A NextDecompressContext with this dictionary in place of the bytes of one. */
  decompressContext(
    format: Format | undefined,
    maxOutputSize: number | undefined,
  ): NextDecompressContext;
  /** Free the dictionary, after which every method throws. */
  free(): void;
}

/** A compression stream: what the CompressionStream class of src/next/api.ts drives. */
export declare class NextCompressContext {
  constructor(
    format: Format,
    level: number | undefined,
    dictionary: Uint8Array | undefined,
    gzipHeader: boolean | undefined,
    gzipFilename: string | undefined,
    gzipMtime: number | undefined,
    workers: number | undefined,
  );
  /** Compress a chunk, and return the output that is ready. */
  transform(chunk: Uint8Array): Bytes;
  /** End the stream, and return the rest of the output. */
  finish(): Bytes;
  /** Free the stream, after which every method throws. */
  free(): void;
}

/** A decompression stream: what the DecompressionStream class of src/next/api.ts drives. */
export declare class NextDecompressContext {
  constructor(
    format: Format | undefined,
    maxOutputSize: number | undefined,
    dictionary: Uint8Array | undefined,
  );
  /** Decompress a chunk, and return the output that is ready. */
  transform(chunk: Uint8Array): Bytes;
  /** End the stream, and return the rest of the output. */
  finish(): Bytes;
  /** Free the stream, after which every method throws. */
  free(): void;
}

export declare function nextCompress(
  data: Uint8Array,
  format: Format,
  level: number | undefined,
  dictionary: Uint8Array | undefined,
  gzipHeader: boolean | undefined,
  gzipFilename: string | undefined,
  gzipMtime: number | undefined,
  workers: number | undefined,
): Bytes;

export declare function nextDecompress(
  data: Uint8Array,
  format: Format | undefined,
  maxOutputSize: number | undefined,
  dictionary: Uint8Array | undefined,
): Bytes;

export declare function nextDetectFormat(data: Uint8Array): Format | null;

export declare function nextTrainDictionary(
  samples: Uint8Array[],
  maxSize: number | undefined,
): Bytes;
