// The WebAssembly module of the gzip build of the unified API (#342),
// which the browser entry point @derodero24/comprs/next/gzip
// (next/browser-gzip.js, compiled from src/next/browser-gzip.ts) imports,
// and the functions and the classes of its wasm-bindgen glue. It loads the
// module as wasm.js loads the full build, and exports what wasm.js exports,
// which wasm-gzip.d.ts declares through wasm.d.ts. Only the modules of the
// package import it. It must stay listed under `sideEffects` in both
// package.json files.

import init from './comprs-wasm-gzip.js';

const wasmUrl = new URL('./comprs-wasm-gzip_bg.wasm', import.meta.url);
try {
  await init({ module_or_path: wasmUrl });
} catch (cause) {
  throw new Error(
    `comprs could not load its WebAssembly module from ${wasmUrl}. See ` +
      'https://github.com/derodero24/comprs#browser-usage for what each bundler needs.',
    { cause },
  );
}

export {
  NextCompressContext,
  NextDecompressContext,
  NextDictionary,
  nextCompress,
  nextDecompress,
  nextDetectFormat,
  nextDetectPrefix,
  nextTrainDictionary,
} from './comprs-wasm-gzip.js';
