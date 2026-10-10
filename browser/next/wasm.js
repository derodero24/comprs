import { NextDictionary, nextCompress, nextDecompress, nextDetectFormat, nextTrainDictionary, } from '../wasm.js';
import { setBackend } from './backend.js';
// The backend of the browser build: the functions of the WebAssembly module
// for the unified API, crates/wasm/src/next.rs, which ../wasm.js loads.
// Importing this module makes them the backend of api.ts.
/**
 * `fn` as a function that returns a Promise of its result, for the async
 * functions of the API. The browser build has no thread pool to run them
 * on, as Node.js has: the returned function calls `fn` on the calling
 * thread, which it blocks until `fn` returns, before it returns the
 * Promise. Like an async function, it reports every error of `fn` by
 * rejecting that Promise, never by throwing.
 */
function asAsync(fn) {
    return (...args) => new Promise((resolve) => resolve(fn(...args)));
}
/**
 * The prepared dictionary that `handle` is: a handle that createDictionary
 * of this backend returned, which api.ts passes back alone.
 */
function prepared(handle) {
    if (handle instanceof NextDictionary)
        return handle;
    throw new TypeError('the dictionary handle is not one of the WebAssembly build');
}
/**
 * Compress `data` as Backend.compress does: with nextCompress(), or, with
 * a prepared dictionary, with its compress(), since the glue takes no
 * optional reference to a NextDictionary as an argument.
 */
function compress(data, format, level, dictionary, gzipHeader, gzipFilename, gzipMtime, workers, dictionaryHandle) {
    if (dictionaryHandle === undefined) {
        return nextCompress(data, format, level, dictionary, gzipHeader, gzipFilename, gzipMtime, workers);
    }
    return prepared(dictionaryHandle).compress(data, format, level, gzipHeader, gzipFilename, gzipMtime, workers);
}
/** Decompress `data` as Backend.decompress does, as compress() does. */
function decompress(data, format, maxOutputSize, dictionary, dictionaryHandle) {
    if (dictionaryHandle === undefined) {
        return nextDecompress(data, format, maxOutputSize, dictionary);
    }
    return prepared(dictionaryHandle).decompress(data, format, maxOutputSize);
}
setBackend({
    compress,
    compressAsync: asAsync(compress),
    decompress,
    decompressAsync: asAsync(decompress),
    detectFormat: nextDetectFormat,
    trainDictionary: nextTrainDictionary,
    trainDictionaryAsync: asAsync(nextTrainDictionary),
    createDictionary: (bytes, format, level) => new NextDictionary(bytes, format, level),
    dictionaryToBytes: (handle) => prepared(handle).toBytes(),
    // The glue also frees a NextDictionary that the garbage collector
    // collects, with a FinalizationRegistry of its own.
    closeDictionary: (handle) => prepared(handle).free(),
});
