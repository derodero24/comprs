import type { Bytes, Format } from './api.js';

/**
 * The codecs behind the functions of api.ts: the hidden binding of the
 * native addon (native.ts), or the functions of the WebAssembly build that
 * browser/wasm.js loads (wasm.ts), whose async functions run on the calling
 * thread.
 *
 * The functions of api.ts check the shapes and the types of their arguments
 * and pass the fields of the options objects on as positional arguments,
 * with `undefined` for a field that is not set. The backend checks the
 * ranges and the combinations of the values, and every error that it
 * throws, or rejects a Promise with, carries the `code` of its category:
 * ERR_COMPRS_INVALID_ARG is a TypeError, every other code a plain Error.
 * Only a trap of the WebAssembly build, after a panic or a failed
 * allocation, fails with a `WebAssembly.RuntimeError` without a code. The
 * inputs are plain bytes that no other agent can write: api.ts copies those
 * in a SharedArrayBuffer.
 */
export interface Backend {
  /**
   * Compress `data` in `format`. `gzipHeader` tells whether the options
   * have a gzip header, which may have no fields; `gzipFilename` and
   * `gzipMtime` hold its fields.
   */
  compress(
    data: Uint8Array,
    format: Format,
    level: number | undefined,
    dictionary: Uint8Array | undefined,
    gzipHeader: boolean | undefined,
    gzipFilename: string | undefined,
    gzipMtime: number | undefined,
    workers: number | undefined,
  ): Bytes;
  /** {@link Backend.compress}, asynchronously. */
  compressAsync(
    data: Uint8Array,
    format: Format,
    level: number | undefined,
    dictionary: Uint8Array | undefined,
    gzipHeader: boolean | undefined,
    gzipFilename: string | undefined,
    gzipMtime: number | undefined,
    workers: number | undefined,
  ): Promise<Bytes>;
  /** Decompress `data` in `format`, or detect its format for `undefined`. */
  decompress(
    data: Uint8Array,
    format: Format | undefined,
    maxOutputSize: number | undefined,
    dictionary: Uint8Array | undefined,
  ): Bytes;
  /** {@link Backend.decompress}, asynchronously. */
  decompressAsync(
    data: Uint8Array,
    format: Format | undefined,
    maxOutputSize: number | undefined,
    dictionary: Uint8Array | undefined,
  ): Promise<Bytes>;
  /** The format of `data`, or `null` if detection does not find one. */
  detectFormat(data: Uint8Array): Format | null;
  /** Train a zstd dictionary of at most `maxSize` bytes from `samples`. */
  trainDictionary(samples: Uint8Array[], maxSize: number | undefined): Bytes;
  /** {@link Backend.trainDictionary}, asynchronously. */
  trainDictionaryAsync(samples: Uint8Array[], maxSize: number | undefined): Promise<Bytes>;
}

let current: Backend | undefined;

/**
 * Make `codecs` the backend of the functions of api.ts. The entry point of
 * each build calls this once, when it is loaded.
 */
export function setBackend(codecs: Backend): void {
  current = codecs;
}

/** The backend that the entry point set. */
export function backend(): Backend {
  if (current === undefined) {
    throw new Error('@derodero24/comprs/next has no backend: import its entry point');
  }
  return current;
}
