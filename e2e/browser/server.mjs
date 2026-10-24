#!/usr/bin/env node

/**
 * Serve the e2e directory over HTTP, as a static web server serves a site:
 * the bundles in dist/, and for the import map fixture, browser/ and the
 * installed package in node_modules/. Files get the type of their
 * extension, `.wasm` files the `application/wasm` type that the README asks
 * for: a bundle that emitted the binary under another extension would make
 * the wasm-bindgen glue log a warning, which fails the test.
 *
 * Usage:
 *   node e2e/browser/server.mjs <port>
 */

import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, sep } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

/** @type {Record<string, string>} */
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.wasm': 'application/wasm',
};

const port = Number(process.argv[2]);
if (!Number.isInteger(port)) {
  throw new Error('Usage: node e2e/browser/server.mjs <port>');
}

createServer(async (request, response) => {
  try {
    const { pathname } = new URL(request.url ?? '/', 'http://localhost');
    const file = pathname.endsWith('/') ? `${pathname}index.html` : pathname;
    const path = join(ROOT, decodeURIComponent(file));
    if (!path.startsWith(ROOT + sep)) {
      throw new Error(`${pathname} is outside the served directory`);
    }
    const body = await readFile(path);
    const type = CONTENT_TYPES[extname(path)] ?? 'application/octet-stream';
    response.writeHead(200, { 'content-type': type }).end(body);
  } catch {
    // With a body, Firefox fires the load event of the error page, which it
    // does not for an empty response.
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found\n');
  }
}).listen(port, 'localhost');
