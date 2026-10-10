// The unified API of comprs (#577), which the entry point of each build
// re-exports with its backend: one function per direction for every format,
// with an options object. This module checks the shapes and the types of the
// arguments; the backend checks their ranges and combinations. It uses
// nothing of a particular runtime, so that the browser build compiles it
// too. The tests check that ErrorCode holds the codes of comprs-core's
// ERROR_CODES, which the backends give.
import { backend, type DictionaryHandle } from './backend.js';

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
export type ErrorCode =
  | 'ERR_COMPRS_INVALID_ARG'
  | 'ERR_COMPRS_UNKNOWN_FORMAT'
  | 'ERR_COMPRS_CORRUPT_DATA'
  | 'ERR_COMPRS_TRUNCATED'
  | 'ERR_COMPRS_SIZE_LIMIT'
  | 'ERR_COMPRS_STREAM_FINISHED'
  | 'ERR_COMPRS_STREAM_CLOSED'
  | 'ERR_COMPRS_OPERATION_FAILED';

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

/** The code of the errors that this module throws itself. */
const INVALID_ARG: ErrorCode = 'ERR_COMPRS_INVALID_ARG';

/** The formats, in the order of their names in error messages. */
const FORMATS: readonly Format[] = ['zstd', 'gzip', 'deflate', 'deflate-raw', 'brotli', 'lz4'];

const FORMAT_SET: ReadonlySet<unknown> = new Set(FORMATS);

/** What {@link Input} may be, in error messages. */
const INPUT_TYPES = 'an ArrayBuffer, SharedArrayBuffer or ArrayBufferView';

/** What the `dictionary` option may be, in error messages. */
const DICTIONARY_TYPES = `a Dictionary or ${INPUT_TYPES}`;

/** The formats of a {@link Dictionary}, in the order of their names in error messages. */
const DICTIONARY_FORMATS: readonly DictionaryOptions['format'][] = ['zstd', 'brotli'];

/**
 * An object whose fields are those of `T`, of any type: what the caller
 * passed for `T`, before it is checked.
 */
type Unchecked<T> = { readonly [K in keyof T]?: unknown };

/**
 * The `dictionary` option, checked: the bytes of a dictionary or the handle
 * of a {@link Dictionary}, as the backend takes them.
 */
interface DictionaryArgs {
  dictionary: Uint8Array | undefined;
  dictionaryHandle: DictionaryHandle | undefined;
}

/** The arguments of Backend.compress, checked. */
interface CompressArgs extends DictionaryArgs {
  data: Uint8Array;
  format: Format;
  level: number | undefined;
  gzipHeader: boolean | undefined;
  gzipFilename: string | undefined;
  gzipMtime: number | undefined;
  workers: number | undefined;
}

/** The arguments of Backend.decompress, checked. */
interface DecompressArgs extends DictionaryArgs {
  data: Uint8Array;
  format: Format | undefined;
  maxOutputSize: number | undefined;
}

/** The arguments of Backend.createDictionary, checked. */
interface CreateDictionaryArgs {
  bytes: Uint8Array;
  format: DictionaryOptions['format'];
  level: number | undefined;
}

/** The arguments of Backend.trainDictionary, checked. */
interface TrainDictionaryArgs {
  samples: Uint8Array[];
  maxSize: number | undefined;
}

/** A TypeError with the code ERR_COMPRS_INVALID_ARG. */
function invalidArg(message: string): TypeError {
  return Object.assign(new TypeError(message), { code: INVALID_ARG });
}

/** Whether `value` is an object, whose fields may be those of `T`. */
function isObject<T>(value: unknown): value is Unchecked<T> {
  return typeof value === 'object' && value !== null;
}

function isFormat(value: unknown): value is Format {
  return FORMAT_SET.has(value);
}

function isDictionaryFormat(value: unknown): value is DictionaryOptions['format'] {
  return value === 'zstd' || value === 'brotli';
}

function isIterable(value: unknown): value is Iterable<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Symbol.iterator in value &&
    typeof value[Symbol.iterator] === 'function'
  );
}

/** `value`, which must be a number or `undefined`. */
function optionalNumber(value: unknown, name: string): number | undefined {
  if (value === undefined || typeof value === 'number') return value;
  throw invalidArg(`${name} must be a number`);
}

/** `value`, which must be a string or `undefined`. */
function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || typeof value === 'string') return value;
  throw invalidArg(`${name} must be a string`);
}

/** A getter of a built-in prototype, if the runtime has it. */
type Getter = (() => unknown) | undefined;

/**
 * The getter of `key` on `prototype`, a built-in prototype.
 *
 * Such a getter reads the internal slots of the value that it is called on,
 * and throws a TypeError for a value without them. That tells buffers and
 * views of every realm apart, such as those of a vm context, which
 * instanceof does not recognize, and neither a Proxy of a buffer, nor a
 * `Symbol.toStringTag`, nor a property that shadows the getter misleads it.
 */
function getterOf(prototype: object | null | undefined, key: PropertyKey): Getter {
  return prototype ? Object.getOwnPropertyDescriptor(prototype, key)?.get : undefined;
}

/** `getter`, called on `value`. A getter that the runtime lacks throws. */
function callGetter(getter: Getter, value: unknown): unknown {
  if (getter === undefined) throw new TypeError('the runtime lacks a getter of a built-in');
  return Reflect.apply(getter, value, []);
}

/** Whether `value` has the internal slots that `getter` reads. */
function hasSlotsOf(getter: Getter, value: unknown): boolean {
  try {
    callGetter(getter, value);
    return true;
  } catch {
    return false;
  }
}

/** The getters of the buffer and the bounds of a view. */
interface ViewGetters {
  readonly buffer: Getter;
  readonly byteOffset: Getter;
  readonly byteLength: Getter;
}

function viewGetters(prototype: object | null): ViewGetters {
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
const TYPED_ARRAY_KEYS: (this: ArrayBufferView) => unknown = Uint8Array.prototype.keys;

const ARRAY_BUFFER_BYTE_LENGTH = getterOf(ArrayBuffer.prototype, 'byteLength');
const ARRAY_BUFFER_DETACHED = getterOf(ArrayBuffer.prototype, 'detached');
const ARRAY_BUFFER_RESIZABLE = getterOf(ArrayBuffer.prototype, 'resizable');

/**
 * The getter of the size of a SharedArrayBuffer. Browsers whose page is not
 * cross-origin isolated have no SharedArrayBuffer, and so no such buffers.
 */
const SHARED_ARRAY_BUFFER_BYTE_LENGTH = getterOf(
  typeof SharedArrayBuffer === 'function' ? SharedArrayBuffer.prototype : undefined,
  'byteLength',
);

/**
 * Whether `value` is an ArrayBuffer, of any realm. The getter of its size
 * throws for every other value, a SharedArrayBuffer included.
 */
function isArrayBuffer(value: unknown): value is ArrayBuffer {
  return hasSlotsOf(ARRAY_BUFFER_BYTE_LENGTH, value);
}

/** Whether `value` is a SharedArrayBuffer, of any realm. */
function isSharedArrayBuffer(value: unknown): value is SharedArrayBuffer {
  return hasSlotsOf(SHARED_ARRAY_BUFFER_BYTE_LENGTH, value);
}

/**
 * Whether `value` inherits from the SharedArrayBuffer of this realm. That
 * proves nothing, but tells whether to ask {@link isSharedArrayBuffer} before
 * {@link isArrayBuffer}: each of them takes microseconds for a buffer of the
 * other kind, for which its getter throws.
 */
function seemsShared(value: unknown): boolean {
  try {
    return typeof SharedArrayBuffer === 'function' && value instanceof SharedArrayBuffer;
  } catch {
    // instanceof runs the getPrototypeOf trap of a Proxy, which may throw.
    return false;
  }
}

/**
 * Whether `buffer`, the buffer of a view, is an ArrayBuffer rather than a
 * SharedArrayBuffer, asked in the order that {@link seemsShared} tells.
 */
function isUnshared(buffer: unknown): buffer is ArrayBuffer {
  return !(seemsShared(buffer) && isSharedArrayBuffer(buffer)) && isArrayBuffer(buffer);
}

/**
 * Whether `buffer` is detached. Runtimes that predate the `detached`
 * property of ArrayBuffer (ES2024) report none: there a detached buffer, or
 * a view of one, may read as empty or fail without a code. Every runtime
 * that the native build supports has the property.
 */
function isDetached(buffer: ArrayBuffer): boolean {
  return ARRAY_BUFFER_DETACHED !== undefined && callGetter(ARRAY_BUFFER_DETACHED, buffer) === true;
}

/**
 * Whether `buffer` is resizable, which runtimes that predate resizable
 * ArrayBuffers (ES2024) never report.
 */
function isResizable(buffer: ArrayBuffer): boolean {
  return (
    ARRAY_BUFFER_RESIZABLE !== undefined && callGetter(ARRAY_BUFFER_RESIZABLE, buffer) === true
  );
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
function viewBytes(view: ArrayBufferView, name: string, types: string): Uint8Array {
  const type = callGetter(TYPED_ARRAY_NAME, view);
  const getters = type === undefined ? DATA_VIEW_GETTERS : TYPED_ARRAY_GETTERS;
  const buffer = callGetter(getters.buffer, view);
  const unshared = isUnshared(buffer);
  if (unshared && isDetached(buffer)) {
    throw invalidArg(`${name} is backed by a detached ArrayBuffer`);
  }
  let byteOffset: unknown;
  let byteLength: unknown;
  try {
    if (unshared && type !== undefined && isResizable(buffer)) {
      Reflect.apply(TYPED_ARRAY_KEYS, view, []);
    }
    byteOffset = callGetter(getters.byteOffset, view);
    byteLength = callGetter(getters.byteLength, view);
  } catch {
    throw invalidArg(`${name} is out of bounds of its ArrayBuffer`);
  }
  if (typeof byteOffset === 'number' && typeof byteLength === 'number') {
    if (unshared) return new Uint8Array(buffer, byteOffset, byteLength);
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
function toBytes(value: unknown, name: string, types: string = INPUT_TYPES): Uint8Array {
  if (ArrayBuffer.isView(value)) return viewBytes(value, name, types);
  if (seemsShared(value) && isSharedArrayBuffer(value)) return new Uint8Array(value).slice();
  if (isArrayBuffer(value)) {
    if (isDetached(value)) throw invalidArg(`${name} is a detached ArrayBuffer`);
    return new Uint8Array(value);
  }
  // A SharedArrayBuffer of another realm.
  if (isSharedArrayBuffer(value)) return new Uint8Array(value).slice();
  throw invalidArg(`${name} must be ${types}`);
}

/**
 * The `dictionary` option, `value`, as the backend takes it: the handle of
 * a {@link Dictionary}, or the bytes of an {@link Input}, which
 * {@link toBytes} reads. A closed Dictionary fails.
 */
function dictionaryArgs(value: unknown): DictionaryArgs {
  if (value === undefined) return { dictionary: undefined, dictionaryHandle: undefined };
  const handle = typeof value === 'object' && value !== null ? handleOf(value) : undefined;
  if (handle !== undefined) return { dictionary: undefined, dictionaryHandle: handle };
  return {
    dictionary: toBytes(value, 'dictionary', DICTIONARY_TYPES),
    dictionaryHandle: undefined,
  };
}

/**
 * Check the arguments of {@link compressSync}. The inputs are read last,
 * after the getters of the options, which could detach their buffers.
 */
function compressArgs(data: unknown, options: unknown): CompressArgs {
  if (!isObject<CompressOptions>(options)) throw invalidArg('options must be an object');
  const format = options.format;
  if (!isFormat(format)) throw invalidArg(`format must be one of ${FORMATS.join(', ')}`);
  const level = optionalNumber(options.level, 'level');
  const dictionary = options.dictionary;
  const header = options.gzipHeader;
  let gzipHeader: boolean | undefined;
  let gzipFilename: string | undefined;
  let gzipMtime: number | undefined;
  if (header !== undefined) {
    if (!isObject<GzipHeaderOptions>(header)) throw invalidArg('gzipHeader must be an object');
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
function decompressArgs(data: unknown, options: unknown): DecompressArgs {
  let format: Format | undefined;
  let maxOutputSize: number | undefined;
  let dictionary: unknown;
  if (options !== undefined) {
    if (!isObject<DecompressOptions>(options)) throw invalidArg('options must be an object');
    const name = options.format;
    if (name !== undefined && name !== 'auto') {
      if (!isFormat(name)) throw invalidArg(`format must be one of auto, ${FORMATS.join(', ')}`);
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
function createDictionaryArgs(bytes: unknown, options: unknown): CreateDictionaryArgs {
  if (!isObject<DictionaryOptions>(options)) throw invalidArg('options must be an object');
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
function trainDictionaryArgs(samples: unknown, options: unknown): TrainDictionaryArgs {
  let maxSize: number | undefined;
  if (options !== undefined) {
    if (!isObject<TrainDictionaryOptions>(options)) throw invalidArg('options must be an object');
    maxSize = optionalNumber(options.maxSize, 'maxSize');
  }
  if (!isIterable(samples)) {
    throw invalidArg(
      'samples must be an iterable of ArrayBuffers, SharedArrayBuffers or ArrayBufferViews',
    );
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
export function compress(data: Input, options: CompressOptions): Promise<Bytes> {
  try {
    const args = compressArgs(data, options);
    return backend().compressAsync(
      args.data,
      args.format,
      args.level,
      args.dictionary,
      args.gzipHeader,
      args.gzipFilename,
      args.gzipMtime,
      args.workers,
      args.dictionaryHandle,
    );
  } catch (error) {
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
export function compressSync(data: Input, options: CompressOptions): Bytes {
  const args = compressArgs(data, options);
  return backend().compress(
    args.data,
    args.format,
    args.level,
    args.dictionary,
    args.gzipHeader,
    args.gzipFilename,
    args.gzipMtime,
    args.workers,
    args.dictionaryHandle,
  );
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
export function decompress(data: Input, options?: DecompressOptions): Promise<Bytes> {
  try {
    const args = decompressArgs(data, options);
    return backend().decompressAsync(
      args.data,
      args.format,
      args.maxOutputSize,
      args.dictionary,
      args.dictionaryHandle,
    );
  } catch (error) {
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
export function decompressSync(data: Input, options?: DecompressOptions): Bytes {
  const args = decompressArgs(data, options);
  return backend().decompress(
    args.data,
    args.format,
    args.maxOutputSize,
    args.dictionary,
    args.dictionaryHandle,
  );
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
export function detectFormat(data: Input): Format | undefined {
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
export function trainDictionary(
  samples: Iterable<Input>,
  options?: TrainDictionaryOptions,
): Promise<Bytes> {
  try {
    const args = trainDictionaryArgs(samples, options);
    return backend().trainDictionaryAsync(args.samples, args.maxSize);
  } catch (error) {
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
export function trainDictionarySync(
  samples: Iterable<Input>,
  options?: TrainDictionaryOptions,
): Bytes {
  const args = trainDictionaryArgs(samples, options);
  return backend().trainDictionary(args.samples, args.maxSize);
}

/** `Symbol.dispose`, if the TypeScript library declares it. */
type DisposeSymbol = SymbolConstructor extends {
  readonly dispose: infer Key extends symbol;
}
  ? Key
  : never;

/**
 * The `[Symbol.dispose]()` method of {@link Dictionary}, which this module
 * defines where the runtime has `Symbol.dispose`. It is declared only where
 * the TypeScript library has it too, so that these declarations also
 * type-check without it, as with the DOM library alone.
 */
type Disposal = { [Key in DisposeSymbol]: () => void };

/**
 * The key without which the constructor of {@link Dictionary} throws, so
 * that {@link Dictionary.from} alone creates dictionaries.
 */
const CONSTRUCT: unique symbol = Symbol('Dictionary');

/**
 * The handle of `value` if it is a {@link Dictionary} that is not closed,
 * or `undefined` if it is no Dictionary. A closed Dictionary fails with
 * `ERR_COMPRS_INVALID_ARG`. The class sets this in its static block, since
 * only its own code reads its private field; until then, no value is a
 * Dictionary.
 */
let handleOf: (value: object) => DictionaryHandle | undefined = () => undefined;

// `Dictionary.prototype[Symbol.dispose]`, where the TypeScript library
// declares `Symbol.dispose`. The class gets it at run time, below.
export interface Dictionary extends Disposal {}

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
  #handle: DictionaryHandle | undefined;

  /** The format that the dictionary is for. */
  readonly format: 'zstd' | 'brotli';

  /** The size of the dictionary, in bytes. */
  readonly byteLength: number;

  private constructor(
    key: symbol,
    handle: DictionaryHandle,
    format: 'zstd' | 'brotli',
    byteLength: number,
  ) {
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
  static from(bytes: Input, options: DictionaryOptions): Dictionary {
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
  toBytes(): Bytes {
    return backend().dictionaryToBytes(this.#open());
  }

  /**
   * Free the memory of the dictionary now, rather than when the garbage
   * collector collects it. Calls that already started with the dictionary
   * finish with it. Later calls with it, and {@link Dictionary.toBytes},
   * fail with `ERR_COMPRS_INVALID_ARG` ("this Dictionary is closed");
   * closing it again does nothing.
   */
  close(): void {
    const handle = this.#handle;
    if (handle === undefined) return;
    this.#handle = undefined;
    backend().closeDictionary(handle);
  }

  /** The handle of the dictionary, which must not be closed. */
  #open(): DictionaryHandle {
    if (this.#handle === undefined) throw invalidArg('this Dictionary is closed');
    return this.#handle;
  }

  static {
    handleOf = (value: object): DictionaryHandle | undefined =>
      #handle in value ? value.#open() : undefined;
  }
}

// [Symbol.dispose]() is close(), as for the stream contexts of the package
// root, where the runtime has Symbol.dispose, which TypeScript's library
// for ES2023 does not declare.
const DISPOSE: unknown = Reflect.get(Symbol, 'dispose');
if (typeof DISPOSE === 'symbol') {
  Object.defineProperty(Dictionary.prototype, DISPOSE, {
    value: Dictionary.prototype.close,
    writable: true,
    configurable: true,
  });
}
