// The WebAssembly module of the browser build, which the browser entry
// (index.js) imports first, and the functions of the wasm-bindgen glue that
// the browser backend of the unified API (next/wasm.js, compiled from
// src/next/wasm.ts) calls. wasm.d.ts declares them as that backend uses
// them; the entry does not re-export them.
//
// The module is fetched and instantiated here, with top-level await, so
// every function of the glue works as soon as an import of this module
// resolves. The package does not export this module: only its own browser
// modules import it. webpack 5 and Vite emit the file that
// `new URL('…', import.meta.url)` names as an asset; with other bundlers, it
// has to be copied next to the bundle (see Browser Usage in the README).
// This module must stay listed under `sideEffects` in both package.json
// files, so that bundlers keep this initialisation in a bundle that uses
// none of its exports.

import init from './comprs-wasm.js';

const wasmUrl = new URL('./comprs-wasm_bg.wasm', import.meta.url);
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
  nextCompress,
  nextDecompress,
  nextDetectFormat,
  nextTrainDictionary,
} from './comprs-wasm.js';
