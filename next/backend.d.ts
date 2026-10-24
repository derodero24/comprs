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
 * A compression or decompression stream of the backend, which the stream
 * classes of api.ts drive: they pass it each chunk of input, call finish()
 * once the input ends, and close() once the stream has finished, failed or
 * been cancelled. They make one call at a time, and wait for the Promise
 * that a call returns to settle before the next one; only close() may come
 * while one is in flight, after a cancel, and the stream then drops what
 * the call returns. Each call returns the output that is ready, which may
 * be empty, or a Promise of it, and reports an error by throwing or by
 * rejecting that Promise, as the functions of the backend do.
 */
export interface CodecStream {
    /**
     * Take a chunk of input, and return the output that is ready. The stream
     * copies what it keeps of the chunk before it returns.
     */
    transform(chunk: Uint8Array): Bytes | Promise<Bytes>;
    /**
     * End the stream, and return the rest of the output. A decompression
     * stream fails if its input did not hold the whole compressed stream.
     */
    finish(): Bytes | Promise<Bytes>;
    /**
     * Release the state of the stream now rather than when the garbage
     * collector collects it. With a call in flight, the state goes once the
     * call settles.
     */
    close(): void;
}
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
     * The formats that the backend includes: every format for the native
     * addon and the full WebAssembly build, and those of one family for a
     * per-format WebAssembly build (#342). It rejects the others with
     * `ERR_COMPRS_INVALID_ARG`.
     */
    readonly formats: readonly Format[];
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
    /**
     * A stream that compresses its input in `format`, with the options of
     * {@link Backend.compress}, which it checks when it is created.
     */
    createCompressStream(format: Format, level: number | undefined, dictionary: Uint8Array | undefined, gzipHeader: boolean | undefined, gzipFilename: string | undefined, gzipMtime: number | undefined, workers: number | undefined, dictionaryHandle: DictionaryHandle | undefined): CodecStream;
    /**
     * A stream that decompresses its input in `format`, or, for `undefined`,
     * in the format of the prepared dictionary or the format that it detects
     * in the input, with the options of {@link Backend.decompress}, which it
     * checks when it is created.
     */
    createDecompressStream(format: Format | undefined, maxOutputSize: number | undefined, dictionary: Uint8Array | undefined, dictionaryHandle: DictionaryHandle | undefined): CodecStream;
    /**
     * The format of `data`, or `null` if detection does not find one. A
     * backend detects the formats with a magic number, gzip, zstd and lz4,
     * even if it does not include them, but zlib and brotli only if it
     * includes them.
     */
    detectFormat(data: Uint8Array): Format | null;
    /**
     * The format of the data that starts with `data`, as
     * {@link Backend.detectFormat} detects it, with `isFinal` if no more data
     * follows: `null` if detection does not find one, or `undefined` while
     * more data could change the answer, which only happens without
     * `isFinal`.
     */
    detectPrefix(data: Uint8Array, isFinal: boolean): Format | null | undefined;
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
 * Make `codecs` the backend of `formats`, the formats of its entry point,
 * for the functions of api.ts. Each entry point calls this once, when it is
 * loaded: `@derodero24/comprs/next` for every format, and those of a family
 * of formats, such as `@derodero24/comprs/next/zstd`, for that family. A
 * format keeps the backend that was registered for it first, so that its
 * calls do not move to another one: the entry points of a page that loads
 * several WebAssembly builds share api.ts, which then calls each build for
 * its formats.
 */
export declare function registerBackend(codecs: Backend, formats: readonly Format[]): void;
/** The backend registered for `format`, if any. */
export declare function backendOf(format: Format): Backend | undefined;
/** Every backend registered for a format, once each, in their order. */
export declare function registeredBackends(): Backend[];
/**
 * Make `replacement` the backend of every format whose backend is
 * `current`, as the tests do to watch the calls of a backend.
 */
export declare function replaceBackend(current: Backend, replacement: Backend): void;
