import type * as Glue from '../wasm.js';
import type { Format } from './api.js';
import type { Backend } from './backend.js';
/**
 * The functions and the classes of the wasm-bindgen glue of a WebAssembly
 * build, which its loader exports once the module is instantiated: those
 * that ../wasm.d.ts declares, for every build.
 */
export type WasmGlue = typeof Glue;
/**
 * The backend of the WebAssembly build of `glue`, which includes `formats`:
 * every format for the full build, those of one family for the build of the
 * family.
 */
export declare function wasmBackend(glue: WasmGlue, formats: readonly Format[]): Backend;
