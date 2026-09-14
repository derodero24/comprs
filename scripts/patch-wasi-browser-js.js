#!/usr/bin/env node

/**
 * Patch comprs.wasi-browser.js to reuse workers lazily.
 *
 * @napi-rs/cli 3.9+ generates the browser WASI loader with
 * `reuseWorker: { size: N }`, which makes @emnapi/wasi-threads pre-spawn a
 * worker pool at start-up. Its pool warm-up assumes a Node.js worker_threads
 * Worker whenever `process.versions.node` exists, so Bun and Deno (which
 * expose that but create Web Workers here) crash with
 * "worker.once is not a function". `reuseWorker: true` keeps the pre-3.9
 * behaviour: workers are still reused, just created on demand.
 *
 * Must be run after `napi build --target wasm32-wasip1-threads`.
 */

'use strict';

const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');

const loaderPath = resolve(__dirname, '..', 'comprs.wasi-browser.js');
if (!existsSync(loaderPath)) {
  console.log('comprs.wasi-browser.js not found, nothing to patch.');
  process.exit(0);
}

const source = readFileSync(loaderPath, 'utf8');
const patched = source.replace(/reuseWorker: \{ size: [^}]+\},/, 'reuseWorker: true,');
if (patched === source) {
  console.log('comprs.wasi-browser.js already uses lazy worker reuse.');
  process.exit(0);
}

writeFileSync(loaderPath, patched);
console.log('Patched comprs.wasi-browser.js → reuseWorker: true');
