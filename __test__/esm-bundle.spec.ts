import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { afterAll, describe, expect, it } from 'vitest';

// The ES module entry as a bundler sees it, when an application for Node.js
// is bundled with the native addon left external. index.mjs re-exports
// index.js with `export *`, so the bundler follows it and bundles the loader;
// a createRequire() call would leave the loader out of the bundle, to be
// loaded from a path next to the bundle at run time.
const ROOT = resolve(__dirname, '..');
const require = createRequire(__filename);
// comprs.<platform>.node, in the package directory or a platform package.
// require.cache can hold other native modules, such as the test runner's.
const NATIVE_ADDON = /[\\/]comprs\.[^\\/]+\.node$/;

const workDir = mkdtempSync(join(tmpdir(), 'comprs-esm-bundle-'));
afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** The native addon that require() loaded, which the bundle loads too. */
function nativeAddonPath(): string {
  require('@derodero24/comprs');
  const addon = Object.keys(require.cache).find((path) => NATIVE_ADDON.test(path));
  if (addon === undefined) {
    throw new Error('require() of the package loaded no native addon');
  }
  return addon;
}

describe('ES module entry bundled for Node.js', () => {
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
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile,
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
    });

    // The bundle runs from a directory without the package, so the loader
    // finds the native addon through the variable that napi-rs provides.
    const stdout = execFileSync(process.execPath, [outfile], {
      cwd: workDir,
      encoding: 'utf8',
      env: { ...process.env, NAPI_RS_NATIVE_LIBRARY_PATH: nativeAddonPath() },
      timeout: 30_000,
    });
    const expectedKeys = new Set([
      ...Object.keys(require('@derodero24/comprs')),
      ...Object.keys(require('@derodero24/comprs/streams')),
    ]);
    const bundled: unknown = JSON.parse(stdout);
    expect(bundled).toEqual({ keys: [...expectedKeys].sort(), restored: 'bundled' });
  });
});
