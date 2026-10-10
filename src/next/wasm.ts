import { nextCompress, nextDecompress, nextDetectFormat, nextTrainDictionary } from '../wasm.js';
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
function asAsync<Args extends unknown[], Result>(
  fn: (...args: Args) => Result,
): (...args: Args) => Promise<Result> {
  return (...args) => new Promise((resolve) => resolve(fn(...args)));
}

setBackend({
  compress: nextCompress,
  compressAsync: asAsync(nextCompress),
  decompress: nextDecompress,
  decompressAsync: asAsync(nextDecompress),
  detectFormat: nextDetectFormat,
  trainDictionary: nextTrainDictionary,
  trainDictionaryAsync: asAsync(nextTrainDictionary),
});
