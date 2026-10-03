#!/usr/bin/env node

/**
 * Build the wasm-bindgen WASM package for browser usage.
 * Uses wasm-pack to build crates/wasm targeting wasm32-unknown-unknown, with
 * wasm-bindgen's `web` target: the glue exports an init function that the
 * browser entry (browser/index.js) awaits, instead of importing the .wasm
 * file as an ES module, which esbuild cannot bundle.
 */

'use strict';

const { execSync } = require('node:child_process');
const { cpSync, rmSync, existsSync } = require('node:fs');
const { join, resolve } = require('node:path');

const ROOT = resolve(__dirname, '..');
const WASM_CRATE = join(ROOT, 'crates', 'wasm');
const OUT_DIR = join(ROOT, '.wasm-pack-out');
const BROWSER_DIR = join(ROOT, 'browser');

// Clean previous output
if (existsSync(OUT_DIR)) {
  rmSync(OUT_DIR, { recursive: true });
}

console.log('Building wasm-bindgen package...');
execSync(`wasm-pack build ${WASM_CRATE} --target web --out-dir ${OUT_DIR} --out-name comprs-wasm`, {
  stdio: 'inherit',
  cwd: ROOT,
});

// Copy the glue, its declarations and the binary next to the browser entry.
// The glue's declarations describe the raw module exports as well
// (InitOutput), so comprs-wasm_bg.wasm.d.ts is not needed.
const files = ['comprs-wasm.js', 'comprs-wasm.d.ts', 'comprs-wasm_bg.wasm'];

for (const file of files) {
  const src = join(OUT_DIR, file);
  if (!existsSync(src)) {
    throw new Error(`${file} not found in the wasm-pack output`);
  }
  cpSync(src, join(BROWSER_DIR, file));
  console.log(`  Copied: browser/${file}`);
}

// Clean up wasm-pack output directory (browser/package.json replaces the
// package.json it generates)
rmSync(OUT_DIR, { recursive: true });

console.log('Done.');
