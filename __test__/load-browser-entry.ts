import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { vi } from 'vitest';

/**
 * The wasm-bindgen build, which `pnpm test` does not build. Suites that load
 * the browser entry are skipped unless `pnpm run build:wasm-bindgen` ran
 * first, as in the WASM Test CI job.
 */
export const HAS_WASM_BUILD = existsSync(resolve(__dirname, '../browser/comprs-wasm_bg.wasm'));

/**
 * The wasm-bindgen glue. Its type declarations exist only once the build has
 * run, so it is imported by a specifier that TypeScript does not resolve.
 */
const GLUE_MODULE: string = '../browser/comprs-wasm.js';

/**
 * Import a module that loads the browser entry, which fetches the
 * WebAssembly module next to it when it is imported. Node's fetch does not
 * support file: URLs, so serve them from disk, as a web server would.
 */
async function withFileFetch<T>(load: () => Promise<T>): Promise<T> {
  vi.stubGlobal(
    'fetch',
    async (url: URL) =>
      new Response(await readFile(url), { headers: { 'content-type': 'application/wasm' } }),
  );
  try {
    return await load();
  } finally {
    vi.unstubAllGlobals();
  }
}

/** Import the browser entry. */
export function importBrowserEntry() {
  return withFileFetch(() => import('../browser/index.js'));
}

/** Import the browser module of `@derodero24/comprs/streams`. */
export function importBrowserStreams() {
  return withFileFetch(() => import('../browser/streams.js'));
}

/** The exports of the browser entry, as browser/index.d.ts declares them. */
export type BrowserEntry = Awaited<ReturnType<typeof importBrowserEntry>>;

/** The exports of browser/streams.js, as browser/streams.d.ts declares them. */
export type BrowserStreams = Awaited<ReturnType<typeof importBrowserStreams>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The members of a `WebAssembly.Memory` that the tests use. */
export interface WasmMemory {
  readonly buffer: ArrayBuffer;
  grow(pages: number): number;
}

function isWasmMemory(value: unknown): value is WasmMemory {
  return isRecord(value) && value.buffer instanceof ArrayBuffer && typeof value.grow === 'function';
}

/**
 * Return the memory of the WebAssembly instance that the browser entry
 * created. Load the entry first: the glue's init function, which the entry
 * called, returns the exports of that instance when it is called again.
 */
export async function wasmMemory(): Promise<WasmMemory> {
  const glue: unknown = await import(GLUE_MODULE);
  const init = isRecord(glue) ? glue.default : undefined;
  if (typeof init !== 'function') {
    throw new Error(`${GLUE_MODULE} has no init function`);
  }
  const exports: unknown = await init();
  const memory = isRecord(exports) ? exports.memory : undefined;
  if (!isWasmMemory(memory)) {
    throw new Error('The WebAssembly instance exports no memory');
  }
  return memory;
}
