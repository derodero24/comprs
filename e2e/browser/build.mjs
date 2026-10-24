#!/usr/bin/env node

/**
 * Build browser/app.js with each bundler of the README's Browser Usage
 * section, set up as that section says, into dist/<bundler>/, next to an
 * index.html that loads the bundle. browser.spec.ts opens these pages; the
 * Vite dev server needs no build, as playwright.config.ts starts it.
 *
 * A bundler that fails does not stop the others: the script exits with
 * status 1 once all have run, and the page of the failed one is missing.
 *
 * Usage:
 *   node e2e/browser/build.mjs
 */

import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import * as esbuild from 'esbuild';
import { build as viteBuild } from 'vite';
import webpack from 'webpack';

const E2E_DIR = join(import.meta.dirname, '..');
const DIST_DIR = join(E2E_DIR, 'dist');
const APP = join(import.meta.dirname, 'app.js');

rmSync(DIST_DIR, { recursive: true, force: true });

// esbuild bundles ES modules with top-level await only as an ES module. It
// leaves `new URL('./comprs-wasm_bg.wasm', import.meta.url)` as it is, so
// the binary goes next to the bundle.
await bundle('esbuild', async (outDir) => {
  await esbuild.build({
    entryPoints: [APP],
    bundle: true,
    format: 'esm',
    outfile: join(outDir, 'app.js'),
    logLevel: 'warning',
  });
  copyFileSync(
    join(E2E_DIR, 'node_modules', '@derodero24', 'comprs', 'browser', 'comprs-wasm_bg.wasm'),
    join(outDir, 'comprs-wasm_bg.wasm'),
  );
  writePage(outDir, 'esbuild', '<script type="module" src="./app.js"></script>');
});

// webpack 5 with its defaults, in production mode, which tree-shakes and
// minifies: it emits the binary as an asset and supports top-level await.
await bundle('webpack', async (outDir) => {
  const compiler = webpack({
    mode: 'production',
    context: E2E_DIR,
    entry: APP,
    output: { path: outDir },
  });
  const stats = await promisify(compiler.run.bind(compiler))();
  await promisify(compiler.close.bind(compiler))();
  if (stats === undefined || stats.hasErrors()) {
    throw new Error(stats?.toString('errors-only') ?? 'webpack returned no stats');
  }
  if (stats.hasWarnings()) {
    console.warn(stats.toString('errors-warnings'));
  }
  writePage(outDir, 'webpack', '<script defer src="./main.js"></script>');
});

// Vite with no configuration, which builds index.html. The relative base
// lets the static server serve the build from a subdirectory.
await bundle('vite', async (outDir) => {
  await viteBuild({
    configFile: false,
    root: import.meta.dirname,
    base: './',
    logLevel: 'warn',
    build: { outDir, emptyOutDir: true },
  });
});

/**
 * Run one bundler, which writes into dist/<name>/. If it fails, report the
 * error, remove what it wrote, and fail the script at the end.
 *
 * @param {string} name
 * @param {(outDir: string) => Promise<void>} build
 */
async function bundle(name, build) {
  const outDir = join(DIST_DIR, name);
  try {
    await build(outDir);
    console.log(`Built dist/${name}`);
  } catch (error) {
    console.error(`${name} failed:`, error);
    rmSync(outDir, { recursive: true, force: true });
    process.exitCode = 1;
  }
}

/**
 * Write the index.html that loads a bundle.
 *
 * @param {string} outDir
 * @param {string} bundler
 * @param {string} script The element that loads the bundle.
 */
function writePage(outDir, bundler, script) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, 'index.html'),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <link rel="icon" href="data:," />
    <title>comprs e2e: ${bundler}</title>
    ${script}
  </head>
  <body></body>
</html>
`,
  );
}
