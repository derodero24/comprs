import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, matchesGlob, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// The browser entry points as bundlers see them (#564, #476): which files
// the `browser` condition selects, how they are parsed and tree-shaken, and
// that importing one is enough to load the WebAssembly module.
const ROOT = resolve(__dirname, '..');
const ENTRY = resolve(ROOT, 'browser/index.js');
const STREAMS_ENTRY = resolve(ROOT, 'browser/streams.js');
// The browser entry of @derodero24/comprs/next (#577), and the module that
// it imports to make the WebAssembly build the backend of its functions.
const NEXT_ENTRY = resolve(ROOT, 'browser/next/browser.js');
const NEXT_BACKEND = resolve(ROOT, 'browser/next/wasm.js');
// The module that loads the WebAssembly module, which the entries import.
const WASM_MODULE = resolve(ROOT, 'browser/wasm.js');
const WASM_FILE = resolve(ROOT, 'browser/comprs-wasm_bg.wasm');
// The JS modules the entry points load, the wasm-bindgen glue among them.
const BROWSER_MODULES = [
  'index.js',
  'streams.js',
  'wasm.js',
  'comprs-wasm.js',
  'next/browser.js',
  'next/wasm.js',
  'next/api.js',
  'next/abort.js',
  'next/backend.js',
].map((file) => resolve(ROOT, 'browser', file));
// How long each Node.js process may run. Vitest fails a test that outlasts
// its own timeout (5 s by default) even while it waits in spawnSync, so the
// tests get twice this.
const PROCESS_TIMEOUT = 30_000;

/**
 * Run an ES module in Node with the `browser` condition, which bundlers set
 * for browser builds, from the package root, where the package can import
 * itself by name.
 */
function runWithBrowserCondition(source: string, preload?: string) {
  const preloadArgs = preload
    ? ['--import', `data:text/javascript,${encodeURIComponent(preload)}`]
    : [];
  return spawnSync(
    process.execPath,
    ['--conditions=browser', ...preloadArgs, '--input-type=module', '--eval', source],
    { cwd: ROOT, encoding: 'utf8', timeout: PROCESS_TIMEOUT },
  );
}

/**
 * Preload that answers `fetch()` for file: URLs, which Node's fetch does not
 * support, from disk, as a web server would. It records each URL in
 * `globalThis.fetchedUrls`. `status` sets the response status.
 */
function serveFiles(status = 200) {
  return `
    import { readFile } from 'node:fs/promises';
    globalThis.fetchedUrls = [];
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      globalThis.fetchedUrls.push(url.href);
      if (${status} !== 200) return new Response('Not found', { status: ${status} });
      return new Response(await readFile(url), { headers: { 'content-type': 'application/wasm' } });
    };`;
}

/** Return the parsed package.json that applies to a file: the nearest one. */
function nearestManifest(file: string): { dir: string; manifest: Record<string, unknown> } {
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    const path = resolve(dir, 'package.json');
    if (existsSync(path)) {
      return { dir, manifest: JSON.parse(readFileSync(path, 'utf8')) };
    }
    if (dirname(dir) === dir) {
      throw new Error(`No package.json applies to ${file}`);
    }
  }
}

/**
 * Whether a package.json's `sideEffects` field marks a file as having side
 * effects, as webpack and Vite read it: a pattern without a `/` matches the
 * file name in any directory.
 */
function hasSideEffects(sideEffects: unknown, packageDir: string, file: string): boolean {
  if (sideEffects === undefined || typeof sideEffects === 'boolean') {
    return sideEffects !== false;
  }
  if (!Array.isArray(sideEffects)) {
    throw new Error(`Invalid sideEffects field: ${JSON.stringify(sideEffects)}`);
  }
  const path = relative(packageDir, file).replaceAll('\\', '/');
  return sideEffects.some((pattern: unknown) => {
    if (typeof pattern !== 'string') {
      return false;
    }
    const glob = pattern.replace(/^\.\//, '');
    return matchesGlob(path, glob.includes('/') ? glob : `**/${glob}`);
  });
}

/** The names that a declaration file declares as exported functions, classes and enums. */
function declaredExports(file: string) {
  const declarations = readFileSync(resolve(ROOT, file), 'utf8');
  return Array.from(
    declarations.matchAll(/^export declare (?:function|class|enum) (\w+)/gm),
    ([, name]) => name,
  ).sort();
}

describe('browser entry', { timeout: 2 * PROCESS_TIMEOUT }, () => {
  // The entry uses top-level await, so it can only be imported. require()
  // keeps resolving to the native addon, as in 2.0.x, for test runners that
  // set the browser condition for CommonJS, such as Jest with jsdom. So do
  // the browser modules of the streams subpath, which imports the entry,
  // and of the next subpath, which imports the module that loads the
  // WebAssembly module. The node subpath is for Node.js only.
  it('is what the browser condition resolves imports of the package to, and only imports', () => {
    const result = runWithBrowserCondition(`
      import { createRequire } from 'node:module';
      const require = createRequire(import.meta.url);
      for (const specifier of ['@derodero24/comprs', '@derodero24/comprs/streams', '@derodero24/comprs/node', '@derodero24/comprs/next']) {
        console.log(import.meta.resolve(specifier));
        console.log(require.resolve(specifier));
      }`);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim().split('\n')).toEqual([
      pathToFileURL(ENTRY).href,
      resolve(ROOT, 'index.js'),
      pathToFileURL(STREAMS_ENTRY).href,
      resolve(ROOT, 'streams.js'),
      pathToFileURL(resolve(ROOT, 'node.js')).href,
      resolve(ROOT, 'node.js'),
      pathToFileURL(NEXT_ENTRY).href,
      resolve(ROOT, 'next/index.js'),
    ]);
  });

  it.each(BROWSER_MODULES.map((file) => [relative(ROOT, file), file]))(
    '%s is parsed as an ES module',
    (_name, file) => {
      expect(nearestManifest(file).manifest['type']).toBe('module');
    },
  );

  // Vite resolves the side effects of a package entry with the package root's
  // package.json, webpack with the nearest one. If either marks the entry as
  // side-effect free, a bundler may skip its initialisation and import the
  // re-exported functions straight from the glue; if either marks wasm.js
  // so, a bundler may drop the import of it, which loads the WebAssembly
  // module. The entries of ./next import the module that sets the backend
  // of their functions, browser/next/wasm.js or next/native.js for Node.js,
  // for that alone: a bundler that dropped the import would leave the
  // functions without a backend. Bundlers that turn CommonJS modules into ES
  // modules, such as Rollup, read the field for next/ as well.
  it.each(
    [
      ENTRY,
      STREAMS_ENTRY,
      WASM_MODULE,
      NEXT_ENTRY,
      NEXT_BACKEND,
      resolve(ROOT, 'next/index.js'),
      resolve(ROOT, 'next/native.js'),
    ].map((file) => [relative(ROOT, file), file]),
  )('%s is not side-effect free for any bundler', (_name, file) => {
    const root: Record<string, unknown> = JSON.parse(
      readFileSync(resolve(ROOT, 'package.json'), 'utf8'),
    );
    expect(hasSideEffects(root['sideEffects'], ROOT, file)).toBe(true);
    const { dir, manifest } = nearestManifest(file);
    expect(hasSideEffects(manifest['sideEffects'], dir, file)).toBe(true);
  });

  describe.skipIf(!existsSync(WASM_FILE))('with the wasm-bindgen build', () => {
    it('loads the WebAssembly module next to it on import, with no init call', () => {
      const result = runWithBrowserCondition(
        `
        import { gzipCompress, gzipDecompress } from '@derodero24/comprs';
        const data = new TextEncoder().encode('hello hello hello hello');
        console.log(JSON.stringify({
          roundTrip: new TextDecoder().decode(gzipDecompress(gzipCompress(data))),
          fetched: globalThis.fetchedUrls,
        }));`,
        serveFiles(),
      );
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toEqual({
        roundTrip: 'hello hello hello hello',
        fetched: [pathToFileURL(WASM_FILE).href],
      });
    });

    it('names the file it could not load', () => {
      const result = runWithBrowserCondition(`import '@derodero24/comprs';`, serveFiles(404));
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        `comprs could not load its WebAssembly module from ${pathToFileURL(WASM_FILE).href}`,
      );
    });

    it('loads the WebAssembly module, and not the native addon, for the streams subpath', () => {
      const result = runWithBrowserCondition(
        `
        import { createRequire } from 'node:module';
        import { createGzipCompressStream, createGzipDecompressStream } from '@derodero24/comprs/streams';
        const data = new TextEncoder().encode('hello hello hello hello');
        const output = new Response(
          new Blob([data]).stream().pipeThrough(createGzipCompressStream()).pipeThrough(createGzipDecompressStream()),
        );
        console.log(JSON.stringify({
          roundTrip: await output.text(),
          fetched: globalThis.fetchedUrls,
          required: Object.keys(createRequire(import.meta.url).cache),
        }));`,
        serveFiles(),
      );
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toEqual({
        roundTrip: 'hello hello hello hello',
        fetched: [pathToFileURL(WASM_FILE).href],
        required: [],
      });
    });

    it('loads the WebAssembly module, and not the native addon, for the next subpath', () => {
      const result = runWithBrowserCondition(
        `
        import { createRequire } from 'node:module';
        import { compress, decompressSync } from '@derodero24/comprs/next';
        const data = new TextEncoder().encode('hello hello hello hello');
        const compressed = await compress(data, { format: 'deflate' });
        let code;
        try {
          decompressSync(compressed.subarray(0, compressed.length >> 1), { format: 'deflate' });
        } catch (error) {
          code = error.code;
        }
        console.log(JSON.stringify({
          roundTrip: new TextDecoder().decode(decompressSync(compressed)),
          code,
          fetched: globalThis.fetchedUrls,
          required: Object.keys(createRequire(import.meta.url).cache),
        }));`,
        serveFiles(),
      );
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toEqual({
        roundTrip: 'hello hello hello hello',
        code: 'ERR_COMPRS_TRUNCATED',
        fetched: [pathToFileURL(WASM_FILE).href],
        required: [],
      });
    });

    // browser/index.d.ts is written by hand, and browser/streams.d.ts is
    // generated from src/browser/streams.ts. This checks the names they
    // declare; wasm-parity.spec.ts and browser-streams.spec.ts check, when
    // they are type-checked, that their signatures agree with the native
    // declarations.
    it.each([
      ['@derodero24/comprs', 'browser/index.d.ts'],
      ['@derodero24/comprs/streams', 'browser/streams.d.ts'],
    ])('%s exports what %s declares', (specifier, declarations) => {
      const result = runWithBrowserCondition(
        `console.log(JSON.stringify(Object.keys(await import('${specifier}'))));`,
        serveFiles(),
      );
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toEqual(declaredExports(declarations));
    });
  });
});
