/**
 * A compression format, by the names of the Compression Streams standard
 * where it has one:
 *
 * - `'zstd'`: Zstandard (RFC 8878);
 * - `'gzip'`: gzip (RFC 1952);
 * - `'deflate'`: the zlib format (RFC 1950), deflate data after a 2-byte
 *   header and before an Adler-32 checksum, as `deflateSync()` of
 *   `node:zlib` writes it;
 * - `'deflate-raw'`: raw deflate (RFC 1951), without a header or a
 *   checksum, as `deflateRawSync()` of `node:zlib` and `deflateCompress()`
 *   of the root entry write it;
 * - `'brotli'`: Brotli (RFC 7932);
 * - `'lz4'`: the LZ4 frame format.
 */
export type Format = 'zstd' | 'gzip' | 'deflate' | 'deflate-raw' | 'brotli' | 'lz4';
/**
 * Bytes that the functions read: any ArrayBuffer, SharedArrayBuffer or
 * ArrayBufferView, of this realm or another one, such as a vm context, read
 * byte for byte, so a `Uint16Array` is not converted element by element.
 * Bytes in a SharedArrayBuffer are copied before they are read, so that
 * another thread writing them cannot change them midway.
 *
 * Any other value fails with `ERR_COMPRS_INVALID_ARG`, a Proxy of a buffer
 * and an object whose `Symbol.toStringTag` names a buffer included. So do a
 * detached ArrayBuffer, a view of one, and a view out of the bounds of a
 * resizable ArrayBuffer that shrank below its end.
 */
export type Input = ArrayBufferLike | ArrayBufferView;
/**
 * Bytes that the functions return: a plain `Uint8Array`, not a Node.js
 * `Buffer`, over an ArrayBuffer.
 *
 * Whether that ArrayBuffer can be transferred, with `postMessage()` or
 * `structuredClone()`, is not guaranteed: copy a result with `slice()` to
 * transfer it.
 */
export type Bytes = ReturnType<Uint8Array['slice']>;
/**
 * The `code` that every error of the functions carries:
 *
 * - `ERR_COMPRS_INVALID_ARG`: an argument or an option is invalid: of the
 *   wrong type, out of range, or not for the format. The error is a
 *   `TypeError`;
 * - `ERR_COMPRS_UNKNOWN_FORMAT`: decompression without a `format` could not
 *   detect the format of the data, empty data included;
 * - `ERR_COMPRS_CORRUPT_DATA`: the data is not valid in its format, or has
 *   data after the end of the compressed stream;
 * - `ERR_COMPRS_TRUNCATED`: the data ends before the end of the compressed
 *   stream, as empty data in a given `format` does;
 * - `ERR_COMPRS_SIZE_LIMIT`: the output would exceed `maxOutputSize`, or,
 *   under a `maxOutputSize` of 64 MiB or less, a zstd frame declares a
 *   window larger than the limit allows, as
 *   {@link DecompressOptions.maxOutputSize} describes;
 * - `ERR_COMPRS_STREAM_FINISHED` and `ERR_COMPRS_STREAM_CLOSED`: a stream
 *   was used after it finished or was closed. The functions of this module
 *   do not give them;
 * - `ERR_COMPRS_OPERATION_FAILED`: any other failure, such as a failed
 *   allocation, or dictionary training that found too little to learn from.
 *
 * Every error but `ERR_COMPRS_INVALID_ARG` is a plain `Error`. New codes may
 * be added in minor releases. An error thrown by the caller's own code, such
 * as a getter of an options object or the iterator of the samples, is passed
 * on unchanged, without a code. In the browser build, a panic, or an
 * allocation that the WebAssembly memory cannot grow for, fails with a
 * `WebAssembly.RuntimeError` instead, without a code.
 */
export type ErrorCode = 'ERR_COMPRS_INVALID_ARG' | 'ERR_COMPRS_UNKNOWN_FORMAT' | 'ERR_COMPRS_CORRUPT_DATA' | 'ERR_COMPRS_TRUNCATED' | 'ERR_COMPRS_SIZE_LIMIT' | 'ERR_COMPRS_STREAM_FINISHED' | 'ERR_COMPRS_STREAM_CLOSED' | 'ERR_COMPRS_OPERATION_FAILED';
/** The fields of the gzip header that {@link CompressOptions.gzipHeader} sets. */
export interface GzipHeaderOptions {
    /**
     * The original name of the file. It must not contain NUL characters and
     * must be at most 65535 bytes long in UTF-8. By default the header has no
     * name.
     */
    filename?: string | undefined;
    /**
     * The modification time, in seconds since the Unix epoch: an integer
     * from 0 to 4294967295. 0, the default, means that there is none.
     */
    mtime?: number | undefined;
}
/**
 * The options of {@link compress} and {@link compressSync}. Other properties
 * are ignored.
 */
export interface CompressOptions {
    /** The format to compress in. */
    format: Format;
    /**
     * The compression level, an integer whose range and default depend on the
     * format:
     *
     * - zstd: -131072 to 22, 3 by default, which 0 also selects. With a
     *   {@link Dictionary}, the default is the level that it was prepared
     *   for. Negative levels trade compression ratio for speed;
     * - gzip, deflate and deflate-raw: 0 (no compression) to 9, 6 by default;
     * - brotli: 0 to 11 (the quality of brotli), 6 by default.
     *
     * lz4 takes no level: leave it out.
     */
    level?: number | undefined;
    /**
     * A dictionary, for zstd and brotli only: a {@link Dictionary} for the
     * format, or the bytes of one, which must not be empty. Decompression
     * needs the same dictionary. A zstd dictionary may be one that
     * {@link trainDictionary} trained, or any bytes.
     *
     * zstd digests the bytes of a dictionary on every call, which costs far
     * more than compressing a small message with it: a {@link Dictionary}
     * digests them once.
     */
    dictionary?: Dictionary | Input | undefined;
    /**
     * The fields of the gzip header, for gzip only. Without it, or with an
     * empty object, the header has no name and no modification time.
     */
    gzipHeader?: GzipHeaderOptions | undefined;
    /**
     * The number of threads that compress zstd data besides the calling one:
     * an integer from 0 to 256, 0 by default, which compresses on the calling
     * thread alone. For zstd only, and for the native build only: the browser
     * build accepts 0 alone.
     *
     * The output can differ from that without workers. zstd compresses inputs
     * of at most 512 KiB on the calling thread whatever the number, and each
     * call starts and stops its own workers, so they pay off for large inputs
     * only. They cost memory too: zstd buffers up to `workers + 3` jobs of
     * the input, gives each job an output buffer of about the same size, and
     * gives each worker a compression context of its own. With 4 workers at
     * level 3, where a job is 8 MiB, compressing 96 MiB took about 60 MiB more
     * memory than without workers for JSON lines, and about 100 MiB more for
     * random bytes.
     *
     * {@link compress} runs on a thread of the libuv pool, whose size
     * `UV_THREADPOOL_SIZE` sets (4 by default), and each call may run
     * `workers` threads on top of it: concurrent calls can run up to
     * `UV_THREADPOOL_SIZE * (workers + 1)` threads.
     */
    workers?: number | undefined;
}
/**
 * The options of {@link decompress} and {@link decompressSync}. Other
 * properties are ignored.
 */
export interface DecompressOptions {
    /**
     * The format of the data, or `'auto'`, the default, to detect it from the
     * data. Detection recognizes zstd, gzip, deflate (zlib), brotli and lz4,
     * but never deflate-raw, which has no header to recognize. Brotli data has
     * no magic number, so detection guesses it, and data that it takes for
     * brotli but that does not decode fails with `ERR_COMPRS_UNKNOWN_FORMAT`.
     *
     * With a {@link Dictionary} as the `dictionary`, `'auto'` stands for the
     * format of the dictionary instead.
     */
    format?: Format | 'auto' | undefined;
    /**
     * The largest output, in bytes: an integer from 0 to
     * `Number.MAX_SAFE_INTEGER`, 268435456 (256 MiB) by default. Output that
     * would be larger fails with `ERR_COMPRS_SIZE_LIMIT`.
     *
     * The limit also bounds the memory of the zstd decoder: under a limit of
     * 64 MiB or less, a zstd frame that declares a window larger than the
     * limit, rounded up to a power of two and never less than 8 MiB, fails
     * with `ERR_COMPRS_SIZE_LIMIT` too. zstd writes no larger window at
     * levels up to 19, so the frames that {@link compress} writes at those
     * levels decode under any limit that their output fits in.
     *
     * In the browser build, limits above 4294967295 (4 GiB - 1) act as
     * 4294967295, since WebAssembly memory cannot hold more: errors name that
     * limit, and a zstd frame that declares a larger content size fails with
     * `ERR_COMPRS_SIZE_LIMIT`.
     */
    maxOutputSize?: number | undefined;
    /**
     * The dictionary that the data was compressed with, for zstd and brotli
     * only: a {@link Dictionary}, or the same bytes, whatever compression
     * took. Bytes need a `format`: with `'auto'`, decompression fails with
     * `ERR_COMPRS_INVALID_ARG`.
     */
    dictionary?: Dictionary | Input | undefined;
}
/** The options of {@link Dictionary.from}. Other properties are ignored. */
export interface DictionaryOptions {
    /** The format that the dictionary is for: `'zstd'` or `'brotli'`. */
    format: 'zstd' | 'brotli';
    /**
     * The zstd compression level to prepare the dictionary for: an integer
     * from -131072 to 22, 3 by default, which 0 also selects. Compression
     * with the dictionary and without a `level` of its own compresses at this
     * level. Other levels work too: the dictionary prepares each on its first
     * use, and keeps the last 3 of them.
     *
     * Brotli dictionaries take no level: leave it out.
     */
    level?: number | undefined;
}
/**
 * The options of {@link trainDictionary} and {@link trainDictionarySync}.
 * Other properties are ignored.
 */
export interface TrainDictionaryOptions {
    /**
     * The largest size of the dictionary, in bytes: an integer from 0 to
     * 16777216 (16 MiB), 112640 (110 KiB) by default.
     */
    maxSize?: number | undefined;
}
/**
 * Compress `data` in `options.format`.
 *
 * The output holds the same bytes as that of the functions of the root
 * entry at the same settings, such as `zstdCompress(data, level)`, or
 * `deflateCompress(data, level)` for `'deflate-raw'`, unless zstd compresses
 * with `workers`, or with a {@link Dictionary} above level 8, or with a
 * Dictionary an input of more than 512 KiB or of at least 128 KiB and at
 * least 6 times the {@link Dictionary.byteLength} of the dictionary. zstd
 * compresses an input of at least 128 KiB and 6 times the size of the
 * dictionary with parameters for its size rather than those that the
 * Dictionary was prepared for, and above level 8 or 512 KiB, it sizes its
 * window or splits blocks otherwise with a Dictionary than with its bytes.
 * The bytes of the dictionary decompress the output either way.
 *
 * The data and the bytes of a dictionary are copied when compress() is
 * called, so changing them afterwards does not change the result, and the
 * call keeps using a {@link Dictionary} that is closed afterwards. In
 * Node.js, the data is compressed on a thread of the libuv pool. The browser
 * build has no such pool: it compresses the data on the calling thread,
 * which it blocks, before compress() returns.
 *
 * @returns A Promise of the compressed data, which rejects on every error,
 * invalid arguments included, with an {@link ErrorCode} as `code`. compress()
 * itself never throws.
 */
export declare function compress(data: Input, options: CompressOptions): Promise<Bytes>;
/**
 * Compress `data` in `options.format`, as {@link compress} does, on the
 * calling thread.
 *
 * @returns The compressed data.
 * @throws An error with an {@link ErrorCode} as `code`.
 */
export declare function compressSync(data: Input, options: CompressOptions): Bytes;
/**
 * Decompress `data`, in `options.format` or the format that detection finds
 * in it.
 *
 * The decoders are strict: data that ends before the end of the compressed
 * stream, empty data included, fails with `ERR_COMPRS_TRUNCATED`, and data
 * after its end with `ERR_COMPRS_CORRUPT_DATA`. zstd and lz4 data may hold
 * several frames, and gzip data several members, which are decompressed one
 * after the other. Without a `format`, data whose format detection does not
 * find, empty data included, fails with `ERR_COMPRS_UNKNOWN_FORMAT`, as
 * {@link DecompressOptions.format} describes.
 *
 * The data and the bytes of a dictionary are copied when decompress() is
 * called, so changing them afterwards does not change the result, and the
 * call keeps using a {@link Dictionary} that is closed afterwards. In
 * Node.js, the data is decompressed on a thread of the libuv pool. The
 * browser build decompresses it on the calling thread, which it blocks,
 * before decompress() returns.
 *
 * @returns A Promise of the decompressed data, which rejects on every error,
 * invalid arguments included, with an {@link ErrorCode} as `code`.
 * decompress() itself never throws.
 */
export declare function decompress(data: Input, options?: DecompressOptions): Promise<Bytes>;
/**
 * Decompress `data`, in `options.format` or the format that detection finds
 * in it, as {@link decompress} does, on the calling thread.
 *
 * @returns The decompressed data.
 * @throws An error with an {@link ErrorCode} as `code`.
 */
export declare function decompressSync(data: Input, options?: DecompressOptions): Bytes;
/**
 * The format of `data`, as {@link decompress} detects it, or `undefined` if
 * it finds none, as for empty data. It is never `'deflate-raw'`, which has no
 * header to recognize, and brotli data, which has no magic number, is only
 * recognized when its start decodes.
 *
 * @throws A TypeError with the code `ERR_COMPRS_INVALID_ARG` if `data` is
 * not an {@link Input}.
 */
export declare function detectFormat(data: Input): Format | undefined;
/**
 * Train a zstd dictionary from `samples`, small pieces of data like those
 * that it will compress. zstd recommends about 100 times as many bytes of
 * samples as the size of the dictionary.
 *
 * The samples are copied when trainDictionary() is called. In Node.js, the
 * dictionary is trained on a thread of the libuv pool. The browser build
 * trains it on the calling thread, which it blocks, before trainDictionary()
 * returns.
 *
 * @returns A Promise of the dictionary, which rejects on every error, invalid
 * arguments included, with an {@link ErrorCode} as `code`: training fails
 * with `ERR_COMPRS_OPERATION_FAILED` without samples or from too little
 * data. trainDictionary() itself never throws.
 */
export declare function trainDictionary(samples: Iterable<Input>, options?: TrainDictionaryOptions): Promise<Bytes>;
/**
 * Train a zstd dictionary from `samples`, as {@link trainDictionary} does, on
 * the calling thread.
 *
 * @returns The dictionary.
 * @throws An error with an {@link ErrorCode} as `code`.
 */
export declare function trainDictionarySync(samples: Iterable<Input>, options?: TrainDictionaryOptions): Bytes;
/** `Symbol.dispose`, if the TypeScript library declares it. */
type DisposeSymbol = SymbolConstructor extends {
    readonly dispose: infer Key extends symbol;
} ? Key : never;
/**
 * The `[Symbol.dispose]()` method of {@link Dictionary}, which this module
 * defines where the runtime has `Symbol.dispose`. It is declared only where
 * the TypeScript library has it too, so that these declarations also
 * type-check without it, as with the DOM library alone.
 */
type Disposal = {
    [Key in DisposeSymbol]: () => void;
};
export interface Dictionary extends Disposal {
}
/**
 * A zstd or brotli dictionary, prepared once for every call that compresses
 * or decompresses with it, as the `dictionary` option of {@link compress},
 * {@link decompress} and their `*Sync` variants.
 *
 * zstd digests the bytes of a dictionary before it compresses or
 * decompresses the first frame with them, which costs far more than a small
 * message: a call with the bytes of a dictionary digests them every time, a
 * Dictionary once. A zstd Dictionary is digested when it is created, for its
 * compression level and for decompression. A brotli Dictionary holds the
 * bytes, which brotli takes as they are and indexes on every call, so it
 * saves little time yet.
 *
 * A Dictionary holds memory outside the JavaScript heap. For zstd, that is
 * a copy of the bytes, a digest for decompression of about their size, and
 * a digest for each compression level that it keeps, which grows with the
 * level: 0.8 MB in all at level 3 for a dictionary of 110 KiB, and 2 MB at
 * level 19. The garbage collector frees it with the Dictionary;
 * {@link Dictionary.close} frees it earlier. `[Symbol.dispose]()` is
 * `close()`, for `using` declarations.
 *
 * A Dictionary is for its {@link Dictionary.format} alone: with any other
 * format, the functions fail with `ERR_COMPRS_INVALID_ARG`, such as "this
 * Dictionary is for zstd". Data compressed with a Dictionary decompresses
 * with its bytes too, and the other way round.
 */
export declare class Dictionary {
    #private;
    /** The format that the dictionary is for. */
    readonly format: 'zstd' | 'brotli';
    /** The size of the dictionary, in bytes. */
    readonly byteLength: number;
    private constructor();
    /**
     * Prepare a dictionary for `options.format` from `bytes`, which may be any
     * bytes but must not be empty, such as a zstd dictionary that
     * {@link trainDictionary} trained. A zstd dictionary is digested for
     * compression at `options.level` and for decompression.
     *
     * The bytes are copied, so changing them afterwards does not change the
     * dictionary.
     *
     * @returns The dictionary.
     * @throws An error with an {@link ErrorCode} as `code`:
     * `ERR_COMPRS_INVALID_ARG` for invalid arguments, a level for a brotli
     * dictionary included, and `ERR_COMPRS_OPERATION_FAILED` for bytes that
     * zstd cannot digest, such as a trained dictionary cut short.
     */
    static from(bytes: Input, options: DictionaryOptions): Dictionary;
    /**
     * A copy of the bytes of the dictionary, which decompress what the
     * dictionary compressed, and compress what it decompresses.
     *
     * @throws A TypeError with the code `ERR_COMPRS_INVALID_ARG` once the
     * dictionary is closed.
     */
    toBytes(): Bytes;
    /**
     * Free the memory of the dictionary now, rather than when the garbage
     * collector collects it. Calls that already started with the dictionary
     * finish with it. Later calls with it, and {@link Dictionary.toBytes},
     * fail with `ERR_COMPRS_INVALID_ARG` ("this Dictionary is closed");
     * closing it again does nothing.
     */
    close(): void;
}
export {};
