import type * as Glue from '../wasm.js';
import type { Bytes, DictionaryOptions, Format } from './api.js';
import type { Backend, CodecStream, DictionaryHandle } from './backend.js';

// The backends of the browser build: the functions of a WebAssembly module
// for the unified API, crates/wasm/src/next.rs, that a loader in browser/
// loads: ../wasm.js the full build, and ../wasm-<family>.js the build of a
// family of formats (#342). The entry points for browsers register them for
// their formats.

/**
 * The functions and the classes of the wasm-bindgen glue of a WebAssembly
 * build, which its loader exports once the module is instantiated: those
 * that ../wasm.d.ts declares, for every build.
 */
export type WasmGlue = typeof Glue;

/**
 * `fn` as a function that returns a Promise of its result, for the async
 * functions of the API. The browser build has no thread pool to run them
 * on, as Node.js has: the returned function calls `fn` on the calling
 * thread, which it blocks until `fn` returns, before it returns the
 * Promise. Like an async function, it reports every error of `fn` by
 * rejecting that Promise, never by throwing.
 *
 * The functions of the Backend interface also take a Withdrawal, after the
 * arguments of `fn`, which ignores it: it is always `undefined` here, since
 * the work is done before an abort could withdraw it.
 */
function asAsync<Args extends unknown[], Result>(
  fn: (...args: Args) => Result,
): (...args: Args) => Promise<Result> {
  return (...args) => new Promise((resolve) => resolve(fn(...args)));
}

/**
 * The backend of the WebAssembly build of `glue`, which includes `formats`:
 * every format for the full build, those of one family for the build of the
 * family.
 */
export function wasmBackend(glue: WasmGlue, formats: readonly Format[]): Backend {
  const { NextCompressContext, NextDecompressContext, NextDictionary } = glue;

  /**
   * The prepared dictionary that `handle` is: a handle that createDictionary
   * of this backend returned, which api.ts passes back alone.
   */
  const prepared = (handle: DictionaryHandle): Glue.NextDictionary => {
    if (handle instanceof NextDictionary) {
      return handle;
    }
    throw new TypeError('the dictionary handle is not one of this WebAssembly build');
  };

  /**
   * Compress `data` as Backend.compress does: with nextCompress(), or, with
   * a prepared dictionary, with its compress(), since the glue takes no
   * optional reference to a NextDictionary as an argument.
   */
  const compress = (
    data: Uint8Array,
    format: Format,
    level: number | undefined,
    dictionary: Uint8Array | undefined,
    gzipHeader: boolean | undefined,
    gzipFilename: string | undefined,
    gzipMtime: number | undefined,
    workers: number | undefined,
    dictionaryHandle: DictionaryHandle | undefined,
  ): Bytes => {
    if (dictionaryHandle === undefined) {
      return glue.nextCompress(
        data,
        format,
        level,
        dictionary,
        gzipHeader,
        gzipFilename,
        gzipMtime,
        workers,
      );
    }
    return prepared(dictionaryHandle).compress(
      data,
      format,
      level,
      gzipHeader,
      gzipFilename,
      gzipMtime,
      workers,
    );
  };

  /** Decompress `data` as Backend.decompress does, as compress() does. */
  const decompress = (
    data: Uint8Array,
    format: Format | undefined,
    maxOutputSize: number | undefined,
    dictionary: Uint8Array | undefined,
    dictionaryHandle: DictionaryHandle | undefined,
  ): Bytes => {
    if (dictionaryHandle === undefined) {
      return glue.nextDecompress(data, format, maxOutputSize, dictionary);
    }
    return prepared(dictionaryHandle).decompress(data, format, maxOutputSize);
  };

  return {
    formats,
    compress,
    compressAsync: asAsync(compress),
    decompress,
    decompressAsync: asAsync(decompress),
    detectFormat: glue.nextDetectFormat,
    detectPrefix: glue.nextDetectPrefix,
    trainDictionary: glue.nextTrainDictionary,
    trainDictionaryAsync: asAsync(glue.nextTrainDictionary),
    createDictionary: (
      bytes: Uint8Array,
      format: DictionaryOptions['format'],
      level: number | undefined,
    ): Glue.NextDictionary => new NextDictionary(bytes, format, level),
    dictionaryToBytes: (handle: DictionaryHandle): Bytes => prepared(handle).toBytes(),
    // The glue also frees a NextDictionary that the garbage collector
    // collects, with a FinalizationRegistry of its own.
    closeDictionary: (handle: DictionaryHandle): void => prepared(handle).free(),
    // The async functions do their work before they return, so there is no
    // work for an abort to withdraw.
    createWithdrawal: (): undefined => undefined,
    withdraw: (): boolean => false,
    // The streams call the glue as compress() and decompress() do.
    createCompressStream: (
      format: Format,
      level: number | undefined,
      dictionary: Uint8Array | undefined,
      gzipHeader: boolean | undefined,
      gzipFilename: string | undefined,
      gzipMtime: number | undefined,
      workers: number | undefined,
      dictionaryHandle: DictionaryHandle | undefined,
    ): CodecStream => {
      if (dictionaryHandle === undefined) {
        return stream(
          new NextCompressContext(
            format,
            level,
            dictionary,
            gzipHeader,
            gzipFilename,
            gzipMtime,
            workers,
          ),
        );
      }
      return stream(
        prepared(dictionaryHandle).compressContext(
          format,
          level,
          gzipHeader,
          gzipFilename,
          gzipMtime,
          workers,
        ),
      );
    },
    createDecompressStream: (
      format: Format | undefined,
      maxOutputSize: number | undefined,
      dictionary: Uint8Array | undefined,
      dictionaryHandle: DictionaryHandle | undefined,
    ): CodecStream => {
      if (dictionaryHandle === undefined) {
        return stream(new NextDecompressContext(format, maxOutputSize, dictionary));
      }
      return stream(prepared(dictionaryHandle).decompressContext(format, maxOutputSize));
    },
  };
}

/**
 * The stream of `context`, which returns its output before each call
 * returns: the browser build has no thread pool to run the calls on. close()
 * frees the context, which the glue also frees, with a FinalizationRegistry
 * of its own, when the garbage collector collects a stream that was never
 * closed.
 */
function stream(context: Glue.NextCompressContext | Glue.NextDecompressContext): CodecStream {
  return {
    transform: (chunk: Uint8Array): Bytes => context.transform(chunk),
    finish: (): Bytes => context.finish(),
    close: (): void => context.free(),
  };
}
