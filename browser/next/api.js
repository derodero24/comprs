// The unified API of comprs (#577), which the entry point of each build
// re-exports with its backend: one function per direction for every format,
// with an options object. This module checks the shapes and the types of the
// arguments; the backend checks their ranges and combinations. It uses
// nothing of a particular runtime, so that the browser build compiles it
// too. The tests check that ErrorCode holds the codes of comprs-core's
// ERROR_CODES, which the backends give.
import { backend } from './backend.js';
/** The code of the errors that this module throws itself. */
const INVALID_ARG = 'ERR_COMPRS_INVALID_ARG';
/** The formats, in the order of their names in error messages. */
const FORMATS = ['zstd', 'gzip', 'deflate', 'deflate-raw', 'brotli', 'lz4'];
const FORMAT_SET = new Set(FORMATS);
/** What {@link Input} may be, in error messages. */
const INPUT_TYPES = 'an ArrayBuffer, SharedArrayBuffer or ArrayBufferView';
/** What the `dictionary` option may be, in error messages. */
const DICTIONARY_TYPES = `a Dictionary or ${INPUT_TYPES}`;
/** The formats of a {@link Dictionary}, in the order of their names in error messages. */
const DICTIONARY_FORMATS = ['zstd', 'brotli'];
/** A TypeError with the code ERR_COMPRS_INVALID_ARG. */
function invalidArg(message) {
    return Object.assign(new TypeError(message), { code: INVALID_ARG });
}
/** Whether `value` is an object, whose fields may be those of `T`. */
function isObject(value) {
    return typeof value === 'object' && value !== null;
}
function isFormat(value) {
    return FORMAT_SET.has(value);
}
function isDictionaryFormat(value) {
    return value === 'zstd' || value === 'brotli';
}
function isIterable(value) {
    return (typeof value === 'object' &&
        value !== null &&
        Symbol.iterator in value &&
        typeof value[Symbol.iterator] === 'function');
}
/** `value`, which must be a number or `undefined`. */
function optionalNumber(value, name) {
    if (value === undefined || typeof value === 'number')
        return value;
    throw invalidArg(`${name} must be a number`);
}
/** `value`, which must be a string or `undefined`. */
function optionalString(value, name) {
    if (value === undefined || typeof value === 'string')
        return value;
    throw invalidArg(`${name} must be a string`);
}
/**
 * The getter of `key` on `prototype`, a built-in prototype.
 *
 * Such a getter reads the internal slots of the value that it is called on,
 * and throws a TypeError for a value without them. That tells buffers and
 * views of every realm apart, such as those of a vm context, which
 * instanceof does not recognize, and neither a Proxy of a buffer, nor a
 * `Symbol.toStringTag`, nor a property that shadows the getter misleads it.
 */
function getterOf(prototype, key) {
    return prototype ? Object.getOwnPropertyDescriptor(prototype, key)?.get : undefined;
}
/** `getter`, called on `value`. A getter that the runtime lacks throws. */
function callGetter(getter, value) {
    if (getter === undefined)
        throw new TypeError('the runtime lacks a getter of a built-in');
    return Reflect.apply(getter, value, []);
}
/** Whether `value` has the internal slots that `getter` reads. */
function hasSlotsOf(getter, value) {
    try {
        callGetter(getter, value);
        return true;
    }
    catch {
        return false;
    }
}
function viewGetters(prototype) {
    return {
        buffer: getterOf(prototype, 'buffer'),
        byteOffset: getterOf(prototype, 'byteOffset'),
        byteLength: getterOf(prototype, 'byteLength'),
    };
}
/** %TypedArray%.prototype, which every typed array inherits from. */
const TYPED_ARRAY_PROTOTYPE = Reflect.getPrototypeOf(Uint8Array.prototype);
const TYPED_ARRAY_GETTERS = viewGetters(TYPED_ARRAY_PROTOTYPE);
const DATA_VIEW_GETTERS = viewGetters(DataView.prototype);
/**
 * The getter of the name of the type of a typed array, such as
 * `'Uint8Array'` for a Buffer too, which returns `undefined` for any other
 * value.
 */
const TYPED_ARRAY_NAME = getterOf(TYPED_ARRAY_PROTOTYPE, Symbol.toStringTag);
/**
 * keys() of %TypedArray%.prototype, which throws for a typed array out of
 * the bounds of its buffer, and allocates nothing but an iterator.
 */
const TYPED_ARRAY_KEYS = Uint8Array.prototype.keys;
const ARRAY_BUFFER_BYTE_LENGTH = getterOf(ArrayBuffer.prototype, 'byteLength');
const ARRAY_BUFFER_DETACHED = getterOf(ArrayBuffer.prototype, 'detached');
const ARRAY_BUFFER_RESIZABLE = getterOf(ArrayBuffer.prototype, 'resizable');
/**
 * The getter of the size of a SharedArrayBuffer. Browsers whose page is not
 * cross-origin isolated have no SharedArrayBuffer, and so no such buffers.
 */
const SHARED_ARRAY_BUFFER_BYTE_LENGTH = getterOf(typeof SharedArrayBuffer === 'function' ? SharedArrayBuffer.prototype : undefined, 'byteLength');
/**
 * Whether `value` is an ArrayBuffer, of any realm. The getter of its size
 * throws for every other value, a SharedArrayBuffer included.
 */
function isArrayBuffer(value) {
    return hasSlotsOf(ARRAY_BUFFER_BYTE_LENGTH, value);
}
/** Whether `value` is a SharedArrayBuffer, of any realm. */
function isSharedArrayBuffer(value) {
    return hasSlotsOf(SHARED_ARRAY_BUFFER_BYTE_LENGTH, value);
}
/**
 * Whether `value` inherits from the SharedArrayBuffer of this realm. That
 * proves nothing, but tells whether to ask {@link isSharedArrayBuffer} before
 * {@link isArrayBuffer}: each of them takes microseconds for a buffer of the
 * other kind, for which its getter throws.
 */
function seemsShared(value) {
    try {
        return typeof SharedArrayBuffer === 'function' && value instanceof SharedArrayBuffer;
    }
    catch {
        // instanceof runs the getPrototypeOf trap of a Proxy, which may throw.
        return false;
    }
}
/**
 * Whether `buffer`, the buffer of a view, is an ArrayBuffer rather than a
 * SharedArrayBuffer, asked in the order that {@link seemsShared} tells.
 */
function isUnshared(buffer) {
    return !(seemsShared(buffer) && isSharedArrayBuffer(buffer)) && isArrayBuffer(buffer);
}
/**
 * Whether `buffer` is detached. Runtimes that predate the `detached`
 * property of ArrayBuffer (ES2024) report none: there a detached buffer, or
 * a view of one, may read as empty or fail without a code. Every runtime
 * that the native build supports has the property.
 */
function isDetached(buffer) {
    return ARRAY_BUFFER_DETACHED !== undefined && callGetter(ARRAY_BUFFER_DETACHED, buffer) === true;
}
/**
 * Whether `buffer` is resizable, which runtimes that predate resizable
 * ArrayBuffers (ES2024) never report.
 */
function isResizable(buffer) {
    return (ARRAY_BUFFER_RESIZABLE !== undefined && callGetter(ARRAY_BUFFER_RESIZABLE, buffer) === true);
}
/**
 * {@link toBytes} for a view. Its buffer and its bounds are read with the
 * getters of built-in prototypes, which no property of the view shadows,
 * and the backend gets a new Uint8Array over them, never the view itself,
 * not even a Uint8Array: the wasm-bindgen glue sizes its copies by the
 * `length` property, which a subclass or an own property of the view can
 * make disagree with its bytes.
 *
 * A view is out of bounds once its buffer, a resizable ArrayBuffer, shrank
 * below its end: a SharedArrayBuffer only grows, and other buffers keep
 * their size. The getters of a DataView throw for such a view, but those of
 * a typed array read it as empty, at an offset of 0, so keys(), which
 * throws for it, checks a typed array first.
 */
function viewBytes(view, name, types) {
    const type = callGetter(TYPED_ARRAY_NAME, view);
    const getters = type === undefined ? DATA_VIEW_GETTERS : TYPED_ARRAY_GETTERS;
    const buffer = callGetter(getters.buffer, view);
    const unshared = isUnshared(buffer);
    if (unshared && isDetached(buffer)) {
        throw invalidArg(`${name} is backed by a detached ArrayBuffer`);
    }
    let byteOffset;
    let byteLength;
    try {
        if (unshared && type !== undefined && isResizable(buffer)) {
            Reflect.apply(TYPED_ARRAY_KEYS, view, []);
        }
        byteOffset = callGetter(getters.byteOffset, view);
        byteLength = callGetter(getters.byteLength, view);
    }
    catch {
        throw invalidArg(`${name} is out of bounds of its ArrayBuffer`);
    }
    if (typeof byteOffset === 'number' && typeof byteLength === 'number') {
        if (unshared)
            return new Uint8Array(buffer, byteOffset, byteLength);
        if (isSharedArrayBuffer(buffer)) {
            return new Uint8Array(buffer, byteOffset, byteLength).slice();
        }
    }
    // The getters of every view return its buffer and two numbers.
    throw invalidArg(`${name} must be ${types}`);
}
/**
 * The bytes of `value`, an {@link Input} that the error messages call
 * `name`, as a new Uint8Array that the backend may read: over the same bytes
 * for an ArrayBuffer and a view of one, and over a copy of the bytes in a
 * SharedArrayBuffer. Any other value fails with a message that says that
 * `name` must be `types`.
 *
 * A detached buffer and a view out of bounds fail here with a code, before
 * `new Uint8Array()` fails on them without one, or reads them as empty.
 */
function toBytes(value, name, types = INPUT_TYPES) {
    if (ArrayBuffer.isView(value))
        return viewBytes(value, name, types);
    if (seemsShared(value) && isSharedArrayBuffer(value))
        return new Uint8Array(value).slice();
    if (isArrayBuffer(value)) {
        if (isDetached(value))
            throw invalidArg(`${name} is a detached ArrayBuffer`);
        return new Uint8Array(value);
    }
    // A SharedArrayBuffer of another realm.
    if (isSharedArrayBuffer(value))
        return new Uint8Array(value).slice();
    throw invalidArg(`${name} must be ${types}`);
}
/**
 * The `dictionary` option, `value`, as the backend takes it: the handle of
 * a {@link Dictionary}, or the bytes of an {@link Input}, which
 * {@link toBytes} reads. A closed Dictionary fails.
 */
function dictionaryArgs(value) {
    if (value === undefined)
        return { dictionary: undefined, dictionaryHandle: undefined };
    const handle = typeof value === 'object' && value !== null ? handleOf(value) : undefined;
    if (handle !== undefined)
        return { dictionary: undefined, dictionaryHandle: handle };
    return {
        dictionary: toBytes(value, 'dictionary', DICTIONARY_TYPES),
        dictionaryHandle: undefined,
    };
}
/**
 * Check the arguments of {@link compressSync}. The inputs are read last,
 * after the getters of the options, which could detach their buffers.
 */
function compressArgs(data, options) {
    if (!isObject(options))
        throw invalidArg('options must be an object');
    const format = options.format;
    if (!isFormat(format))
        throw invalidArg(`format must be one of ${FORMATS.join(', ')}`);
    const level = optionalNumber(options.level, 'level');
    const dictionary = options.dictionary;
    const header = options.gzipHeader;
    let gzipHeader;
    let gzipFilename;
    let gzipMtime;
    if (header !== undefined) {
        if (!isObject(header))
            throw invalidArg('gzipHeader must be an object');
        gzipHeader = true;
        gzipFilename = optionalString(header.filename, 'gzipHeader.filename');
        gzipMtime = optionalNumber(header.mtime, 'gzipHeader.mtime');
    }
    const workers = optionalNumber(options.workers, 'workers');
    return {
        data: toBytes(data, 'data'),
        format,
        level,
        ...dictionaryArgs(dictionary),
        gzipHeader,
        gzipFilename,
        gzipMtime,
        workers,
    };
}
/** Check the arguments of {@link decompressSync}, as compressArgs does. */
function decompressArgs(data, options) {
    let format;
    let maxOutputSize;
    let dictionary;
    if (options !== undefined) {
        if (!isObject(options))
            throw invalidArg('options must be an object');
        const name = options.format;
        if (name !== undefined && name !== 'auto') {
            if (!isFormat(name))
                throw invalidArg(`format must be one of auto, ${FORMATS.join(', ')}`);
            format = name;
        }
        maxOutputSize = optionalNumber(options.maxOutputSize, 'maxOutputSize');
        dictionary = options.dictionary;
    }
    return {
        data: toBytes(data, 'data'),
        format,
        maxOutputSize,
        ...dictionaryArgs(dictionary),
    };
}
/** Check the arguments of {@link Dictionary.from}, as compressArgs does. */
function createDictionaryArgs(bytes, options) {
    if (!isObject(options))
        throw invalidArg('options must be an object');
    const format = options.format;
    if (!isDictionaryFormat(format)) {
        throw invalidArg(`format must be one of ${DICTIONARY_FORMATS.join(', ')}`);
    }
    const level = optionalNumber(options.level, 'level');
    return { bytes: toBytes(bytes, 'bytes'), format, level };
}
/**
 * Check the arguments of {@link trainDictionarySync}. The samples are read
 * after the iterator ends, which could detach the buffers of earlier ones.
 */
function trainDictionaryArgs(samples, options) {
    let maxSize;
    if (options !== undefined) {
        if (!isObject(options))
            throw invalidArg('options must be an object');
        maxSize = optionalNumber(options.maxSize, 'maxSize');
    }
    if (!isIterable(samples)) {
        throw invalidArg('samples must be an iterable of ArrayBuffers, SharedArrayBuffers or ArrayBufferViews');
    }
    return {
        samples: Array.from(samples).map((sample, index) => toBytes(sample, `samples[${index}]`)),
        maxSize,
    };
}
/**
 * Compress `data` in `options.format`.
 *
 * The output holds the same bytes as that of the functions of the root
 * entry at the same settings, such as `zstdCompress(data, level)`, or
 * `deflateCompress(data, level)` for `'deflate-raw'`, unless zstd compresses
 * with `workers`, or a large input with a {@link Dictionary}.
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
export function compress(data, options) {
    try {
        const args = compressArgs(data, options);
        return backend().compressAsync(args.data, args.format, args.level, args.dictionary, args.gzipHeader, args.gzipFilename, args.gzipMtime, args.workers, args.dictionaryHandle);
    }
    catch (error) {
        return Promise.reject(error);
    }
}
/**
 * Compress `data` in `options.format`, as {@link compress} does, on the
 * calling thread.
 *
 * @returns The compressed data.
 * @throws An error with an {@link ErrorCode} as `code`.
 */
export function compressSync(data, options) {
    const args = compressArgs(data, options);
    return backend().compress(args.data, args.format, args.level, args.dictionary, args.gzipHeader, args.gzipFilename, args.gzipMtime, args.workers, args.dictionaryHandle);
}
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
export function decompress(data, options) {
    try {
        const args = decompressArgs(data, options);
        return backend().decompressAsync(args.data, args.format, args.maxOutputSize, args.dictionary, args.dictionaryHandle);
    }
    catch (error) {
        return Promise.reject(error);
    }
}
/**
 * Decompress `data`, in `options.format` or the format that detection finds
 * in it, as {@link decompress} does, on the calling thread.
 *
 * @returns The decompressed data.
 * @throws An error with an {@link ErrorCode} as `code`.
 */
export function decompressSync(data, options) {
    const args = decompressArgs(data, options);
    return backend().decompress(args.data, args.format, args.maxOutputSize, args.dictionary, args.dictionaryHandle);
}
/**
 * The format of `data`, as {@link decompress} detects it, or `undefined` if
 * it finds none, as for empty data. It is never `'deflate-raw'`, which has no
 * header to recognize, and brotli data, which has no magic number, is only
 * recognized when its start decodes.
 *
 * @throws A TypeError with the code `ERR_COMPRS_INVALID_ARG` if `data` is
 * not an {@link Input}.
 */
export function detectFormat(data) {
    return backend().detectFormat(toBytes(data, 'data')) ?? undefined;
}
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
export function trainDictionary(samples, options) {
    try {
        const args = trainDictionaryArgs(samples, options);
        return backend().trainDictionaryAsync(args.samples, args.maxSize);
    }
    catch (error) {
        return Promise.reject(error);
    }
}
/**
 * Train a zstd dictionary from `samples`, as {@link trainDictionary} does, on
 * the calling thread.
 *
 * @returns The dictionary.
 * @throws An error with an {@link ErrorCode} as `code`.
 */
export function trainDictionarySync(samples, options) {
    const args = trainDictionaryArgs(samples, options);
    return backend().trainDictionary(args.samples, args.maxSize);
}
/**
 * The key without which the constructor of {@link Dictionary} throws, so
 * that {@link Dictionary.from} alone creates dictionaries.
 */
const CONSTRUCT = Symbol('Dictionary');
/**
 * The handle of `value` if it is a {@link Dictionary} that is not closed,
 * or `undefined` if it is no Dictionary. A closed Dictionary fails with
 * `ERR_COMPRS_INVALID_ARG`. The class sets this in its static block, since
 * only its own code reads its private field; until then, no value is a
 * Dictionary.
 */
let handleOf = () => undefined;
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
// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: the interface only declares the [Symbol.dispose]() method that this module adds to the class.
export class Dictionary {
    /** The dictionary of the backend, or `undefined` once closed. */
    #handle;
    /** The format that the dictionary is for. */
    format;
    /** The size of the dictionary, in bytes. */
    byteLength;
    constructor(key, handle, format, byteLength) {
        if (key !== CONSTRUCT) {
            throw invalidArg('Dictionary cannot be constructed: create one with Dictionary.from()');
        }
        this.#handle = handle;
        this.format = format;
        this.byteLength = byteLength;
    }
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
    static from(bytes, options) {
        const args = createDictionaryArgs(bytes, options);
        const handle = backend().createDictionary(args.bytes, args.format, args.level);
        return new Dictionary(CONSTRUCT, handle, args.format, args.bytes.byteLength);
    }
    /**
     * A copy of the bytes of the dictionary, which decompress what the
     * dictionary compressed, and compress what it decompresses.
     *
     * @throws A TypeError with the code `ERR_COMPRS_INVALID_ARG` once the
     * dictionary is closed.
     */
    toBytes() {
        return backend().dictionaryToBytes(this.#open());
    }
    /**
     * Free the memory of the dictionary now, rather than when the garbage
     * collector collects it. Calls that already started with the dictionary
     * finish with it. Later calls with it, and {@link Dictionary.toBytes},
     * fail with `ERR_COMPRS_INVALID_ARG` ("this Dictionary is closed");
     * closing it again does nothing.
     */
    close() {
        const handle = this.#handle;
        if (handle === undefined)
            return;
        this.#handle = undefined;
        backend().closeDictionary(handle);
    }
    /** The handle of the dictionary, which must not be closed. */
    #open() {
        if (this.#handle === undefined)
            throw invalidArg('this Dictionary is closed');
        return this.#handle;
    }
    static {
        handleOf = (value) => #handle in value ? value.#open() : undefined;
    }
}
// [Symbol.dispose]() is close(), as for the stream contexts of the package
// root, where the runtime has Symbol.dispose, which TypeScript's library
// for ES2023 does not declare.
const DISPOSE = Reflect.get(Symbol, 'dispose');
if (typeof DISPOSE === 'symbol') {
    Object.defineProperty(Dictionary.prototype, DISPOSE, {
        value: Dictionary.prototype.close,
        writable: true,
        configurable: true,
    });
}
