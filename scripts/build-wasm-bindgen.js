#!/usr/bin/env node

/**
 * Build the wasm-bindgen WASM packages for browser usage: the full build,
 * comprs-wasm, with every format and both APIs, and one build of the unified
 * API per family of formats, comprs-wasm-<family> (#342), with the Cargo
 * features of crates/wasm.
 * Uses wasm-pack to build crates/wasm targeting wasm32-unknown-unknown, with
 * wasm-bindgen's `web` target: the glue exports an init function that
 * browser/wasm.js awaits, for the browser entry (browser/index.js) and the
 * browser build of ./next, instead of importing the .wasm file as an ES
 * module, which esbuild cannot bundle.
 *
 * The build uses the wasm-release profile of the workspace Cargo.toml, which
 * optimizes for size, and does not run wasm-opt (see that profile).
 * scripts/wasm-size.mjs reports the size of each result.
 *
 * Usage:
 *   node scripts/build-wasm-bindgen.js [<build>...]
 *
 *   <build>  `full`, `zstd`, `gzip`, `brotli` or `lz4`; every build when
 *            none is named.
 */

'use strict';

const { execFileSync } = require('node:child_process');
const { cpSync, rmSync, existsSync } = require('node:fs');
const { join, resolve } = require('node:path');

const ROOT = resolve(__dirname, '..');
const WASM_CRATE = join(ROOT, 'crates', 'wasm');
const OUT_DIR = join(ROOT, '.wasm-pack-out');
const BROWSER_DIR = join(ROOT, 'browser');

/**
 * The builds: the name of the files of each, and the Cargo features that
 * it passes, after `--no-default-features` for a per-format build.
 */
const BUILDS = {
  full: { name: 'comprs-wasm', features: undefined },
  zstd: { name: 'comprs-wasm-zstd', features: 'zstd' },
  gzip: { name: 'comprs-wasm-gzip', features: 'gzip' },
  brotli: { name: 'comprs-wasm-brotli', features: 'brotli' },
  lz4: { name: 'comprs-wasm-lz4', features: 'lz4' },
};

const requested = process.argv.slice(2);
for (const build of requested) {
  if (!Object.hasOwn(BUILDS, build)) {
    throw new Error(`unknown build ${build}: expected one of ${Object.keys(BUILDS).join(', ')}`);
  }
}

for (const [build, { name, features }] of Object.entries(BUILDS)) {
  if (requested.length > 0 && !requested.includes(build)) {
    continue;
  }
  if (existsSync(OUT_DIR)) {
    rmSync(OUT_DIR, { recursive: true });
  }

  console.log(`Building wasm-bindgen package ${name}...`);
  // The arguments are passed without a shell, so paths with spaces or shell
  // metacharacters reach wasm-pack unchanged. wasm-pack passes those after
  // `--` on to cargo.
  execFileSync(
    'wasm-pack',
    [
      'build',
      WASM_CRATE,
      '--profile',
      'wasm-release',
      '--target',
      'web',
      '--out-dir',
      OUT_DIR,
      '--out-name',
      name,
      ...(features === undefined ? [] : ['--', '--no-default-features', '--features', features]),
    ],
    { stdio: 'inherit', cwd: ROOT },
  );

  // Copy the glue, its declarations and the binary next to the browser
  // entry. The glue's declarations describe the raw module exports as well
  // (InitOutput), so <name>_bg.wasm.d.ts is not needed.
  for (const file of [`${name}.js`, `${name}.d.ts`, `${name}_bg.wasm`]) {
    const src = join(OUT_DIR, file);
    if (!existsSync(src)) {
      throw new Error(`${file} not found in the wasm-pack output`);
    }
    cpSync(src, join(BROWSER_DIR, file));
    console.log(`  Copied: browser/${file}`);
  }
}

// Clean up wasm-pack output directory (browser/package.json replaces the
// package.json it generates)
if (existsSync(OUT_DIR)) {
  rmSync(OUT_DIR, { recursive: true });
}

console.log('Done.');
