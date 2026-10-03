import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, matchesGlob, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// The browser entry as bundlers see it (#564): which file the `browser`
// condition selects, how its files are parsed and tree-shaken, and that
// importing it is enough to load the WebAssembly module.
const ROOT = resolve(__dirname, '..');
const ENTRY = resolve(ROOT, 'browser/index.js');
const WASM_FILE = resolve(ROOT, 'browser/comprs-wasm_bg.wasm');
// The JS modules the entry loads, the wasm-bindgen glue among them.
const BROWSER_MODULES = ['index.js', 'comprs-wasm.js'].map((file) =>
  resolve(ROOT, 'browser', file),
);

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
    { cwd: ROOT, encoding: 'utf8', timeout: 30_000 },
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

describe('browser entry', () => {
  // The entry uses top-level await, so it can only be imported. require()
  // keeps resolving to the native addon, as in 2.0.x, for test runners that
  // set the browser condition for CommonJS, such as Jest with jsdom.
  it('is what the browser condition resolves imports of the package to, and only imports', () => {
    const result = runWithBrowserCondition(`
      import { createRequire } from 'node:module';
      console.log(import.meta.resolve('@derodero24/comprs'));
      console.log(createRequire(import.meta.url).resolve('@derodero24/comprs'));`);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim().split('\n')).toEqual([
      pathToFileURL(ENTRY).href,
      resolve(ROOT, 'index.js'),
    ]);
  });

  it.each(BROWSER_MODULES.map((file) => [relative(ROOT, file), file]))(
    '%s is parsed as an ES module',
    (_name, file) => {
      expect(nearestManifest(file).manifest.type).toBe('module');
    },
  );

  // Vite resolves the side effects of a package entry with the package root's
  // package.json, webpack with the nearest one. If either marks the entry as
  // side-effect free, a bundler may skip its initialisation and import the
  // re-exported functions straight from the glue.
  it('is not side-effect free for any bundler', () => {
    const root: Record<string, unknown> = JSON.parse(
      readFileSync(resolve(ROOT, 'package.json'), 'utf8'),
    );
    expect(hasSideEffects(root.sideEffects, ROOT, ENTRY)).toBe(true);
    const { dir, manifest } = nearestManifest(ENTRY);
    expect(hasSideEffects(manifest.sideEffects, dir, ENTRY)).toBe(true);
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

    // browser/index.d.ts is written by hand. This checks the names it
    // declares; wasm-parity.spec.ts checks, when it is type-checked, that
    // its signatures agree with the native declarations.
    it('exports what its type declarations declare', () => {
      const result = runWithBrowserCondition(
        `console.log(JSON.stringify(Object.keys(await import('@derodero24/comprs'))));`,
        serveFiles(),
      );
      const declarations = readFileSync(resolve(ROOT, 'browser/index.d.ts'), 'utf8');
      const declared = Array.from(
        declarations.matchAll(/^export declare (?:function|class) (\w+)/gm),
        ([, name]) => name,
      );
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toEqual(declared.sort());
    });
  });
});
