#!/usr/bin/env node

/**
 * Patch browser.js to use wasm-bindgen output.
 *
 * napi build/version regenerates browser.js to point at the WASI WASM package.
 * This script overwrites it to use the wasm-bindgen output instead.
 *
 * Must be run after any napi build or napi version command.
 */

'use strict';

const { writeFileSync } = require('node:fs');
const { resolve } = require('node:path');

const browserJsPath = resolve(__dirname, '..', 'browser.js');
writeFileSync(browserJsPath, "export * from './comprs-wasm.js'\n");
console.log('Patched browser.js → ./comprs-wasm.js');
