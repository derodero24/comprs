#!/usr/bin/env node

/**
 * Build the wasm-bindgen WASM package for browser usage.
 * Uses wasm-pack to build crates/wasm targeting wasm32-unknown-unknown.
 */

'use strict';

const { execSync } = require('node:child_process');
const { cpSync, rmSync, existsSync } = require('node:fs');
const { join, resolve } = require('node:path');

const ROOT = resolve(__dirname, '..');
const WASM_CRATE = join(ROOT, 'crates', 'wasm');
const OUT_DIR = join(ROOT, '.wasm-pack-out');

// Clean previous output
if (existsSync(OUT_DIR)) {
  rmSync(OUT_DIR, { recursive: true });
}

console.log('Building wasm-bindgen package...');
execSync(
  `wasm-pack build ${WASM_CRATE} --target bundler --out-dir ${OUT_DIR} --out-name comprs-wasm`,
  { stdio: 'inherit', cwd: ROOT },
);

// Copy output files to project root
const files = [
  'comprs-wasm.js',
  'comprs-wasm_bg.js',
  'comprs-wasm_bg.wasm',
  'comprs-wasm.d.ts',
  'comprs-wasm_bg.wasm.d.ts',
];

for (const file of files) {
  const src = join(OUT_DIR, file);
  const dest = join(ROOT, file);
  if (existsSync(src)) {
    cpSync(src, dest);
    console.log(`  Copied: ${file}`);
  } else {
    console.warn(`  Warning: ${file} not found in output`);
  }
}

// Clean up wasm-pack output directory (it generates a package.json we don't want)
rmSync(OUT_DIR, { recursive: true });

console.log('Done.');
