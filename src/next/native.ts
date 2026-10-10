import {
  BROTLI_DICT_REACH,
  type CodecOp,
  type ContextModel,
  codecScheduler,
  zstdSetupMs,
} from '../stream-schedule.js';
import type { Bytes, Format } from './api.js';
import { type Backend, type CodecStream, type DictionaryHandle, setBackend } from './backend.js';

// The backend of the native build: the hidden binding of the native addon,
// crates/core/src/next.rs, which the addon keeps on its exports under
// Symbol.for('@derodero24/comprs/internal') so that the root entry does not
// list it. Importing this module makes it the backend of api.ts.

/** The key of the hidden binding on the exports of the addon. */
const INTERNAL = Symbol.for('@derodero24/comprs/internal');

/**
 * The state of a stream of the binding: an `External` that only the
 * binding reads, and that releases the state when the garbage collector
 * collects it.
 */
type Context = object;

/**
 * The functions of the binding: those of the backend, but its stream
 * methods, which this module builds on the stream functions of the binding.
 */
interface Binding extends Omit<Backend, 'createCompressStream' | 'createDecompressStream'> {
  createCompressContext(
    format: Format,
    level: number | undefined,
    dictionary: Uint8Array | undefined,
    gzipHeader: boolean | undefined,
    gzipFilename: string | undefined,
    gzipMtime: number | undefined,
    workers: number | undefined,
    dictionaryHandle: DictionaryHandle | undefined,
  ): Context;
  createDecompressContext(
    format: Format | undefined,
    maxOutputSize: number | undefined,
    dictionary: Uint8Array | undefined,
    dictionaryHandle: DictionaryHandle | undefined,
  ): Context;
  contextTransform(context: Context, chunk: Uint8Array): Bytes;
  contextTransformAsync(context: Context, chunk: Uint8Array): Promise<Bytes>;
  contextFlush(context: Context): Bytes;
  contextFlushAsync(context: Context): Promise<Bytes>;
  contextFinish(context: Context): Bytes;
  contextFinishAsync(context: Context): Promise<Bytes>;
  contextClose(context: Context): void;
}

/** The functions of the binding that this module calls. */
const FUNCTIONS: readonly (keyof Binding)[] = [
  'compress',
  'compressAsync',
  'decompress',
  'decompressAsync',
  'detectFormat',
  'trainDictionary',
  'trainDictionaryAsync',
  'createDictionary',
  'dictionaryToBytes',
  'closeDictionary',
  'createWithdrawal',
  'withdraw',
  'createCompressContext',
  'createDecompressContext',
  'contextTransform',
  'contextTransformAsync',
  'contextFlush',
  'contextFlushAsync',
  'contextFinish',
  'contextFinishAsync',
  'contextClose',
];

function isBinding(value: unknown): value is Binding {
  return (
    typeof value === 'object' &&
    value !== null &&
    FUNCTIONS.every((name) => typeof Reflect.get(value, name) === 'function')
  );
}

// A plain require() call, which returns the exports of the loader as they
// are: `import * as` would copy them with the interop helper of tsc, which
// leaves out properties keyed by symbols.
const found: unknown = Reflect.get(require('../index.js'), INTERNAL);
if (!isBinding(found)) {
  throw new Error(
    'the native addon of @derodero24/comprs has no binding for @derodero24/comprs/next: it is older than the JavaScript of the package, so reinstall the package',
  );
}
const binding: Binding = found;

/**
 * The codec whose speed the scheduler of a stream in `format` starts from,
 * as msPerBytePrior() names it: raw deflate and zlib run at the speed of
 * gzip. A stream that detects its format holds the start of its input until
 * it knows the format, and then runs at the speed of the format: that of
 * brotli, the slowest decoder, until the scheduler has measured it.
 */
function codecOf(format: Format | undefined): 'zstd' | 'gzip' | 'brotli' | 'lz4' {
  switch (format) {
    case 'zstd':
    case 'gzip':
    case 'lz4':
      return format;
    case 'deflate':
    case 'deflate-raw':
      return 'gzip';
    case 'brotli':
    case undefined:
      return 'brotli';
  }
}

/**
 * The stream of `context`, whose calls a ChunkScheduler for `op` at `level`
 * makes synchronously or on the libuv thread pool, as their predicted time
 * decides, as the stream helpers of the package root do (#554): an
 * expensive chunk does not block the event loop, and a cheap one does not
 * pay for a round trip to the pool.
 */
function scheduled(
  context: Context,
  op: CodecOp,
  level: number | undefined,
  model: ContextModel,
): CodecStream {
  const scheduler = codecScheduler(
    {
      transform: (chunk: Uint8Array): Bytes => binding.contextTransform(context, chunk),
      transformAsync: (chunk: Uint8Array): Promise<Bytes> =>
        binding.contextTransformAsync(context, chunk),
      flush: (): Bytes => binding.contextFlush(context),
      flushAsync: (): Promise<Bytes> => binding.contextFlushAsync(context),
      finish: (): Bytes => binding.contextFinish(context),
      finishAsync: (): Promise<Bytes> => binding.contextFinishAsync(context),
    },
    op,
    level,
    model,
  );
  return {
    transform: (chunk: Uint8Array): Bytes | Promise<Bytes> => scheduler.transform(chunk),
    finish: (): Bytes | Promise<Bytes> => scheduler.finish(),
    close: (): void => binding.contextClose(context),
  };
}

/** Backend.createCompressStream, over the stream functions of the binding. */
function createCompressStream(
  format: Format,
  level: number | undefined,
  dictionary: Uint8Array | undefined,
  gzipHeader: boolean | undefined,
  gzipFilename: string | undefined,
  gzipMtime: number | undefined,
  workers: number | undefined,
  dictionaryHandle: DictionaryHandle | undefined,
): CodecStream {
  const context = binding.createCompressContext(
    format,
    level,
    dictionary,
    gzipHeader,
    gzipFilename,
    gzipMtime,
    workers,
    dictionaryHandle,
  );
  const withDictionary = dictionary !== undefined || dictionaryHandle !== undefined;
  // A zstd stream sets up its encoder on its first chunk, unless it has a
  // dictionary, with which it does so when it is created. A brotli stream
  // with a dictionary holds the start of its input, as the
  // BrotliCompressDictContext of the package root does with
  // `{ incremental: true }`.
  let model: ContextModel = {};
  if (format === 'zstd' && !withDictionary) model = { setupMs: zstdSetupMs(level) };
  if (format === 'brotli' && withDictionary) model = { holds: BROTLI_DICT_REACH };
  return scheduled(context, `${codecOf(format)}-compress`, level, model);
}

/** Backend.createDecompressStream, over the stream functions of the binding. */
function createDecompressStream(
  format: Format | undefined,
  maxOutputSize: number | undefined,
  dictionary: Uint8Array | undefined,
  dictionaryHandle: DictionaryHandle | undefined,
): CodecStream {
  const context = binding.createDecompressContext(
    format,
    maxOutputSize,
    dictionary,
    dictionaryHandle,
  );
  return scheduled(context, `${codecOf(format)}-decompress`, undefined, {});
}

setBackend({
  compress: binding.compress,
  compressAsync: binding.compressAsync,
  decompress: binding.decompress,
  decompressAsync: binding.decompressAsync,
  detectFormat: binding.detectFormat,
  trainDictionary: binding.trainDictionary,
  trainDictionaryAsync: binding.trainDictionaryAsync,
  createDictionary: binding.createDictionary,
  dictionaryToBytes: binding.dictionaryToBytes,
  closeDictionary: binding.closeDictionary,
  createWithdrawal: binding.createWithdrawal,
  withdraw: binding.withdraw,
  createCompressStream,
  createDecompressStream,
});
