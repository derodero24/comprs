// The WebAssembly module of the lz4 build of the unified API (#342),
// which the browser entry point @derodero24/comprs/next/lz4
// (next/browser-lz4.js, compiled from src/next/browser-lz4.ts) imports,
// and the functions and the classes of its wasm-bindgen glue. It loads the
// module as wasm.js loads the full build, and exports what wasm.js exports,
// which wasm-lz4.d.ts declares through wasm.d.ts. Only the modules of the
// package import it. It must stay listed under `sideEffects` in both
// package.json files.

import init from './comprs-wasm-lz4.js';

const wasmUrl = new URL('./comprs-wasm-lz4_bg.wasm', import.meta.url);
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
} from './comprs-wasm-lz4.js';
