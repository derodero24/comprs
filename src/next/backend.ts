import type { Bytes, DictionaryOptions, Format } from './api.js';

/**
 * A dictionary that {@link Backend.createDictionary} prepared, which only
 * the backend reads: an `External` of the native addon, or an object of the
 * WebAssembly build. The `Dictionary` class of api.ts holds it until it is
 * closed.
 */
export type DictionaryHandle = object;

/**
 * The codecs behind the functions of api.ts: the hidden binding of the
 * native addon (native.ts), or the functions of the WebAssembly build that
 * browser/wasm.js loads (wasm.ts), whose async functions run on the calling
 * thread.
 *
 * The functions of api.ts check the shapes and the types of their arguments
 * and pass the fields of the options objects on as positional arguments,
 * with `undefined` for a field that is not set. A `dictionary` option is
 * either the bytes of a dictionary, as `dictionary`, or a prepared one, as
 * `dictionaryHandle`, the last argument: api.ts passes at most one of the
 * two. The backend checks the ranges and the combinations of the values,
 * and every error that it throws, or rejects a Promise with, carries the
 * `code` of its category: ERR_COMPRS_INVALID_ARG is a TypeError, every
 * other code a plain Error. Only a trap of the WebAssembly build, after a
 * panic or a failed allocation, fails with a `WebAssembly.RuntimeError`
 * without a code. The inputs are plain bytes that no other agent can
 * write: api.ts copies those in a SharedArrayBuffer.
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
    dictionaryHandle: DictionaryHandle | undefined,
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
    dictionaryHandle: DictionaryHandle | undefined,
  ): Promise<Bytes>;
  /**
   * Decompress `data` in `format`, or, for `undefined`, in the format of the
   * prepared dictionary or the format that detection finds.
   */
  decompress(
    data: Uint8Array,
    format: Format | undefined,
    maxOutputSize: number | undefined,
    dictionary: Uint8Array | undefined,
    dictionaryHandle: DictionaryHandle | undefined,
  ): Bytes;
  /** {@link Backend.decompress}, asynchronously. */
  decompressAsync(
    data: Uint8Array,
    format: Format | undefined,
    maxOutputSize: number | undefined,
    dictionary: Uint8Array | undefined,
    dictionaryHandle: DictionaryHandle | undefined,
  ): Promise<Bytes>;
  /** The format of `data`, or `null` if detection does not find one. */
  detectFormat(data: Uint8Array): Format | null;
  /** Train a zstd dictionary of at most `maxSize` bytes from `samples`. */
  trainDictionary(samples: Uint8Array[], maxSize: number | undefined): Bytes;
  /** {@link Backend.trainDictionary}, asynchronously. */
  trainDictionaryAsync(samples: Uint8Array[], maxSize: number | undefined): Promise<Bytes>;
  /**
   * Prepare a dictionary for `format` from a copy of `bytes`: for zstd, for
   * the compression `level` and for decompression.
   */
  createDictionary(
    bytes: Uint8Array,
    format: DictionaryOptions['format'],
    level: number | undefined,
  ): DictionaryHandle;
  /** A copy of the bytes of the dictionary of `handle`. */
  dictionaryToBytes(handle: DictionaryHandle): Bytes;
  /**
   * Free the dictionary of `handle` once no call uses it any more. api.ts
   * passes the handle to no function afterwards.
   */
  closeDictionary(handle: DictionaryHandle): void;
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
