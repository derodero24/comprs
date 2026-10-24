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
function asAsync(fn) {
    return (...args) => new Promise((resolve) => resolve(fn(...args)));
}
/**
 * The backend of the WebAssembly build of `glue`, which includes `formats`:
 * every format for the full build, those of one family for the build of the
 * family.
 */
export function wasmBackend(glue, formats) {
    const { NextCompressContext, NextDecompressContext, NextDictionary } = glue;
    /**
     * The prepared dictionary that `handle` is: a handle that createDictionary
     * of this backend returned, which api.ts passes back alone.
     */
    const prepared = (handle) => {
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
    const compress = (data, format, level, dictionary, gzipHeader, gzipFilename, gzipMtime, workers, dictionaryHandle) => {
        if (dictionaryHandle === undefined) {
            return glue.nextCompress(data, format, level, dictionary, gzipHeader, gzipFilename, gzipMtime, workers);
        }
        return prepared(dictionaryHandle).compress(data, format, level, gzipHeader, gzipFilename, gzipMtime, workers);
    };
    /** Decompress `data` as Backend.decompress does, as compress() does. */
    const decompress = (data, format, maxOutputSize, dictionary, dictionaryHandle) => {
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
        createDictionary: (bytes, format, level) => new NextDictionary(bytes, format, level),
        dictionaryToBytes: (handle) => prepared(handle).toBytes(),
        // The glue also frees a NextDictionary that the garbage collector
        // collects, with a FinalizationRegistry of its own.
        closeDictionary: (handle) => prepared(handle).free(),
        // The async functions do their work before they return, so there is no
        // work for an abort to withdraw.
        createWithdrawal: () => undefined,
        withdraw: () => false,
        // The streams call the glue as compress() and decompress() do.
        createCompressStream: (format, level, dictionary, gzipHeader, gzipFilename, gzipMtime, workers, dictionaryHandle) => {
            if (dictionaryHandle === undefined) {
                return stream(new NextCompressContext(format, level, dictionary, gzipHeader, gzipFilename, gzipMtime, workers));
            }
            return stream(prepared(dictionaryHandle).compressContext(format, level, gzipHeader, gzipFilename, gzipMtime, workers));
        },
        createDecompressStream: (format, maxOutputSize, dictionary, dictionaryHandle) => {
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
function stream(context) {
    return {
        transform: (chunk) => context.transform(chunk),
        finish: () => context.finish(),
        close: () => context.free(),
    };
}
