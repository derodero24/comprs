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
 * Import the browser entry, which fetches the WebAssembly module next to it
 * when it is imported. Node's fetch does not support file: URLs, so serve
 * them from disk, as a web server would.
 */
export async function importBrowserEntry() {
  vi.stubGlobal(
    'fetch',
    async (url: URL) =>
      new Response(await readFile(url), { headers: { 'content-type': 'application/wasm' } }),
  );
  try {
    return await import('../browser/index.js');
  } finally {
    vi.unstubAllGlobals();
  }
}

/** The exports of the browser entry, as browser/index.d.ts declares them. */
export type BrowserEntry = Awaited<ReturnType<typeof importBrowserEntry>>;
