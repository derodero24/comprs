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

/** The memory of the WebAssembly instance that the browser entry created. */
let entryMemory: WasmMemory | undefined;

/**
 * Import a module that loads the browser entry, which fetches the
 * WebAssembly module next to it when it is imported. Node's fetch does not
 * support file: URLs, so serve them from disk, as a web server would, with
 * the type that lets the glue compile the response as it streams in. Record
 * the memory of the instance that the entry creates, which it does not
 * export.
 */
async function withFileFetch<T>(load: () => Promise<T>): Promise<T> {
  vi.stubGlobal(
    'fetch',
    async (url: URL) =>
      new Response(await readFile(url), { headers: { 'content-type': 'application/wasm' } }),
  );
  const webAssembly: unknown = Reflect.get(globalThis, 'WebAssembly');
  if (!isWebAssemblyApi(webAssembly)) {
    throw new Error('This runtime has no WebAssembly.instantiateStreaming()');
  }
  const instantiateStreaming = webAssembly.instantiateStreaming.bind(webAssembly);
  const spy = vi
    .spyOn(webAssembly, 'instantiateStreaming')
    .mockImplementation(async (source, imports) => {
      const result = await instantiateStreaming(source, imports);
      const { memory } = result.instance.exports;
      if (isWasmMemory(memory)) {
        entryMemory = memory;
      }
      return result;
    });
  try {
    return await load();
  } finally {
    spy.mockRestore();
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

/**
 * The member of the `WebAssembly` namespace that the glue instantiates the
 * module with. The type check has no declarations for the namespace.
 */
interface WebAssemblyApi {
  instantiateStreaming(
    source: Response | PromiseLike<Response>,
    imports?: object,
  ): Promise<{ instance: { exports: Record<string, unknown> } }>;
}

function isWebAssemblyApi(value: unknown): value is WebAssemblyApi {
  return isRecord(value) && typeof value['instantiateStreaming'] === 'function';
}

function isWasmMemory(value: unknown): value is WasmMemory {
  return (
    isRecord(value) && value['buffer'] instanceof ArrayBuffer && typeof value['grow'] === 'function'
  );
}

/**
 * Return the memory of the WebAssembly instance that the browser entry
 * created when {@link importBrowserEntry} or {@link importBrowserStreams}
 * loaded it.
 */
export function wasmMemory(): WasmMemory {
  if (entryMemory === undefined) {
    throw new Error('The browser entry has not instantiated a WebAssembly module with a memory');
  }
  return entryMemory;
}
