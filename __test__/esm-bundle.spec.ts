import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type BuildOptions, build } from 'esbuild';
import { afterAll, describe, expect, it } from 'vitest';
import { HAS_WASM_BUILD } from './load-browser-entry.js';

// The ES module entries as a bundler sees them, when an application for
// Node.js is bundled with the native addon left external. index.mjs
// re-exports index.js with `export *`, so the bundler follows it and bundles
// the loader; a createRequire() call would leave the loader out of the
// bundle, to be loaded from a path next to the bundle at run time. The
// entry of @derodero24/comprs/next is also bundled for browsers, where it
// loads the WebAssembly build.
const ROOT = resolve(__dirname, '..');
const require = createRequire(__filename);
// comprs.<platform>.node, in the package directory or a platform package.
// require.cache can hold other native modules, such as the test runner's.
const NATIVE_ADDON = /[\\/]comprs\.[^\\/]+\.node$/;
// How long each Node.js process may run. Vitest fails a test that outlasts
// its own timeout (5 s by default) even while it waits in execFileSync, so
// the test, which runs two of them after esbuild, gets three times this.
const PROCESS_TIMEOUT = 30_000;

const workDir = mkdtempSync(join(tmpdir(), 'comprs-esm-bundle-'));
afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/**
 * The options that bundle a CommonJS loader of the native addon into an ES
 * module for Node.js, with the addon left external.
 */
const NODE_BUNDLE: BuildOptions = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['*.node'],
  // The loader is CommonJS and calls require(), which an ES module bundle
  // gets from createRequire().
  banner: {
    js: [
      "import { createRequire as createBundleRequire } from 'node:module';",
      'const require = createBundleRequire(import.meta.url);',
    ].join('\n'),
  },
  logLevel: 'silent',
};

/** The native addon that require() loaded, which the bundle loads too. */
function nativeAddonPath(): string {
  require('@derodero24/comprs');
  const addon = Object.keys(require.cache).find((path) => NATIVE_ADDON.test(path));
  if (addon === undefined) {
    throw new Error('require() of the package loaded no native addon');
  }
  return addon;
}

describe('ES module entry bundled for Node.js', { timeout: 3 * PROCESS_TIMEOUT }, () => {
  it('exports what the CommonJS entry and the stream helpers export', async () => {
    const outfile = join(workDir, 'bundle.mjs');
    await build({
      stdin: {
        contents: [
          "import * as comprs from '@derodero24/comprs';",
          "const data = new TextEncoder().encode('bundled');",
          'const restored = comprs.gzipDecompress(comprs.gzipCompress(data));',
          'process.stdout.write(JSON.stringify({',
          '  keys: Object.keys(comprs).sort(),',
          '  restored: new TextDecoder().decode(restored),',
          '}));',
        ].join('\n'),
        resolveDir: ROOT,
        sourcefile: 'app.mjs',
      },
      ...NODE_BUNDLE,
      outfile,
    });

    // The bundle runs from a directory without the package, so the loader
    // finds the native addon through the variable that napi-rs provides.
    const stdout = execFileSync(process.execPath, [outfile], {
      cwd: workDir,
      encoding: 'utf8',
      env: { ...process.env, NAPI_RS_NATIVE_LIBRARY_PATH: nativeAddonPath() },
      timeout: PROCESS_TIMEOUT,
    });
    // The names that the CommonJS entries export, read in a process of
    // its own. A require() of the streams entry here would load streams.js
    // a second time next to the copy that Vitest transforms, and V8 would
    // report both copies under one URL, which corrupts the coverage of
    // streams.js.
    const cjsKeys: unknown = JSON.parse(
      execFileSync(
        process.execPath,
        [
          '--eval',
          [
            "const keys = new Set([...Object.keys(require('@derodero24/comprs')),",
            "  ...Object.keys(require('@derodero24/comprs/streams'))]);",
            'process.stdout.write(JSON.stringify([...keys].sort()));',
          ].join('\n'),
        ],
        { cwd: ROOT, encoding: 'utf8', timeout: PROCESS_TIMEOUT },
      ),
    );
    const bundled: unknown = JSON.parse(stdout);
    expect(bundled).toEqual({ keys: cjsKeys, restored: 'bundled' });
  });
});

/**
 * An application of @derodero24/comprs/next, which prints the names that the
 * entry exports, a round trip, and the code of the error of a cut stream.
 */
const NEXT_APP = [
  "import * as next from '@derodero24/comprs/next';",
  "const data = new TextEncoder().encode('bundled');",
  "const compressed = await next.compress(data, { format: 'deflate' });",
  'let code;',
  'try {',
  "  next.decompressSync(compressed.subarray(0, compressed.length >> 1), { format: 'deflate' });",
  '} catch (error) {',
  '  code = error.code;',
  '}',
  'console.log(JSON.stringify({',
  '  keys: Object.keys(next).sort(),',
  '  restored: new TextDecoder().decode(next.decompressSync(compressed)),',
  '  code,',
  '}));',
].join('\n');

/**
 * Bundle {@link NEXT_APP} into `outfile` with `options` and return the
 * files of the package that the bundle holds.
 */
async function bundleNextApp(outfile: string, options: BuildOptions): Promise<string[]> {
  const { metafile } = await build({
    stdin: { contents: NEXT_APP, resolveDir: ROOT, sourcefile: 'app.mjs' },
    ...options,
    outfile,
    metafile: true,
  });
  return Object.keys(metafile.inputs).filter((input) => input !== 'app.mjs');
}

/**
 * What require('@derodero24/comprs/next') exports, read in a process of its
 * own: a require() of next/index.js here would load it next to the copy that
 * Vitest transforms, which corrupts its coverage.
 */
function nextCjsKeys(): unknown {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        '--eval',
        "process.stdout.write(JSON.stringify(Object.keys(require('@derodero24/comprs/next')).sort()));",
      ],
      { cwd: ROOT, encoding: 'utf8', timeout: PROCESS_TIMEOUT },
    ),
  );
}

describe('./next bundled', { timeout: 3 * PROCESS_TIMEOUT }, () => {
  it('for Node.js, exports what its CommonJS entry exports, over the native addon', async () => {
    const outfile = join(workDir, 'next-node.mjs');
    const inputs = await bundleNextApp(outfile, NODE_BUNDLE);
    expect(inputs).toContain('next/index.mjs');
    expect(inputs).toContain('index.js');

    const stdout = execFileSync(process.execPath, [outfile], {
      cwd: workDir,
      encoding: 'utf8',
      env: { ...process.env, NAPI_RS_NATIVE_LIBRARY_PATH: nativeAddonPath() },
      timeout: PROCESS_TIMEOUT,
    });
    expect(JSON.parse(stdout)).toEqual({
      keys: nextCjsKeys(),
      restored: 'bundled',
      code: 'ERR_COMPRS_TRUNCATED',
    });
  });

  // The `browser` condition picks browser/next/browser.js, which loads the
  // WebAssembly module through browser/wasm.js. esbuild leaves its
  // `new URL('./comprs-wasm_bg.wasm', import.meta.url)` as it is, so the
  // binary goes next to the bundle, as the README says, and the bundle
  // runs in Node.js, whose fetch() gets file: URLs from a preload.
  it.skipIf(!HAS_WASM_BUILD)(
    'for browsers, exports the same names, over the WebAssembly build alone',
    async () => {
      const outfile = join(workDir, 'next-browser.mjs');
      const inputs = await bundleNextApp(outfile, {
        bundle: true,
        platform: 'browser',
        format: 'esm',
        logLevel: 'silent',
      });
      expect(inputs).toContain('browser/next/browser.js');
      expect(inputs).toContain('browser/comprs-wasm.js');
      expect(inputs.filter((input) => !input.startsWith('browser/'))).toEqual([]);

      copyFileSync(
        resolve(ROOT, 'browser/comprs-wasm_bg.wasm'),
        join(workDir, 'comprs-wasm_bg.wasm'),
      );
      const serveFiles = [
        "import { readFile } from 'node:fs/promises';",
        'globalThis.fetch = async (input) =>',
        '  new Response(await readFile(new URL(String(input))), {',
        "    headers: { 'content-type': 'application/wasm' },",
        '  });',
      ].join('\n');
      const stdout = execFileSync(
        process.execPath,
        ['--import', `data:text/javascript,${encodeURIComponent(serveFiles)}`, outfile],
        { cwd: workDir, encoding: 'utf8', timeout: PROCESS_TIMEOUT },
      );
      expect(JSON.parse(stdout)).toEqual({
        keys: nextCjsKeys(),
        restored: 'bundled',
        code: 'ERR_COMPRS_TRUNCATED',
      });
    },
  );
});
