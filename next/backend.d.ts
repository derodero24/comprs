import type { Bytes, DictionaryOptions, Format } from './api.js';
/**
 * A dictionary that {@link Backend.createDictionary} prepared, which only
 * the backend reads: an `External` of the native addon, or an object of the
 * WebAssembly build. The `Dictionary` class of api.ts holds it until it is
 * closed.
 */
export type DictionaryHandle = object;
/**
 * The handle of the work of one call of an async function, which
 * {@link Backend.createWithdrawal} returns and the function takes last, and
 * through which {@link Backend.withdraw} withdraws the work: an `External`
 * of the native addon.
 */
export type Withdrawal = object;
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
 * `dictionaryHandle`, the last of the arguments that hold options: api.ts
 * passes at most one of the two. The backend checks the ranges and the
 * combinations of the values, and every error that it throws, or rejects a
 * Promise with, carries the `code` of its category: ERR_COMPRS_INVALID_ARG
 * is a TypeError, every other code a plain Error. Only a trap of the
 * WebAssembly build, after a panic or a failed allocation, fails with a
 * `WebAssembly.RuntimeError` without a code. The inputs are plain bytes
 * that no other agent can write: api.ts copies those in a
 * SharedArrayBuffer.
 *
 * The async functions take a {@link Withdrawal} after `dictionaryHandle`,
 * last, for a call with an AbortSignal, or `undefined`. The signal itself
 * stays in api.ts, which withdraws the work when it aborts and settles the
 * call. The work that {@link Backend.withdraw} withdrew rejects with an
 * error without such a code, the `Cancelled` status of napi-rs in the
 * native addon, which api.ts never passes on: it has settled the call with
 * the reason of the signal by then.
 */
export interface Backend {
    /**
     * Compress `data` in `format`. `gzipHeader` tells whether the options
     * have a gzip header, which may have no fields; `gzipFilename` and
     * `gzipMtime` hold its fields.
     */
    compress(data: Uint8Array, format: Format, level: number | undefined, dictionary: Uint8Array | undefined, gzipHeader: boolean | undefined, gzipFilename: string | undefined, gzipMtime: number | undefined, workers: number | undefined, dictionaryHandle: DictionaryHandle | undefined): Bytes;
    /** {@link Backend.compress}, asynchronously. */
    compressAsync(data: Uint8Array, format: Format, level: number | undefined, dictionary: Uint8Array | undefined, gzipHeader: boolean | undefined, gzipFilename: string | undefined, gzipMtime: number | undefined, workers: number | undefined, dictionaryHandle: DictionaryHandle | undefined, withdrawal: Withdrawal | undefined): Promise<Bytes>;
    /**
     * Decompress `data` in `format`, or, for `undefined`, in the format of the
     * prepared dictionary or the format that detection finds.
     */
    decompress(data: Uint8Array, format: Format | undefined, maxOutputSize: number | undefined, dictionary: Uint8Array | undefined, dictionaryHandle: DictionaryHandle | undefined): Bytes;
    /** {@link Backend.decompress}, asynchronously. */
    decompressAsync(data: Uint8Array, format: Format | undefined, maxOutputSize: number | undefined, dictionary: Uint8Array | undefined, dictionaryHandle: DictionaryHandle | undefined, withdrawal: Withdrawal | undefined): Promise<Bytes>;
    /** The format of `data`, or `null` if detection does not find one. */
    detectFormat(data: Uint8Array): Format | null;
    /** Train a zstd dictionary of at most `maxSize` bytes from `samples`. */
    trainDictionary(samples: Uint8Array[], maxSize: number | undefined): Bytes;
    /** {@link Backend.trainDictionary}, asynchronously. */
    trainDictionaryAsync(samples: Uint8Array[], maxSize: number | undefined, withdrawal: Withdrawal | undefined): Promise<Bytes>;
    /**
     * Prepare a dictionary for `format` from a copy of `bytes`: for zstd, for
     * the compression `level` and for decompression.
     */
    createDictionary(bytes: Uint8Array, format: DictionaryOptions['format'], level: number | undefined): DictionaryHandle;
    /** A copy of the bytes of the dictionary of `handle`. */
    dictionaryToBytes(handle: DictionaryHandle): Bytes;
    /**
     * Free the dictionary of `handle` once no call uses it any more. api.ts
     * passes the handle to no function afterwards.
     */
    closeDictionary(handle: DictionaryHandle): void;
    /**
     * A {@link Withdrawal} for the work of one call of an async function, or
     * `undefined` if the backend cannot withdraw work: the WebAssembly backend
     * does the work before the function returns.
     */
    createWithdrawal(): Withdrawal | undefined;
    /**
     * Withdraw the work of the call that took `withdrawal`: whether no thread
     * had started it, which then none will. The Promise of the call settles
     * later, when a thread of the pool reaches and skips the work, and api.ts
     * settles the call at once instead. Work that a thread has started runs
     * to the end.
     */
    withdraw(withdrawal: Withdrawal): boolean;
}
/**
 * Make `codecs` the backend of the functions of api.ts. The entry point of
 * each build calls this once, when it is loaded.
 */
export declare function setBackend(codecs: Backend): void;
/** The backend that the entry point set. */
export declare function backend(): Backend;
