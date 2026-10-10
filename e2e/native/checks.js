// Checks of the entry points that load the native addon, which
// native/import.mjs and native/require.cjs run in Node.js, Deno and Bun on
// the installed package: the checks of ../scenario.js, plus what only the
// native build has.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { checkPackage } from '../scenario.js';

/** Where install-package.mjs installs the package. */
const PACKAGE_DIR = join(import.meta.dirname, '..', 'node_modules', '@derodero24', 'comprs');

/**
 * What `require('@derodero24/comprs')` returns; the ES module entry
 * re-exports the helpers of `@derodero24/comprs/streams` as well.
 *
 * @typedef {typeof import('@derodero24/comprs', { with: { 'resolution-mode': 'require' } })} Main
 */

/**
 * @typedef {object} NativePackage
 * @property {Main} main `@derodero24/comprs`
 * @property {typeof import('@derodero24/comprs/streams')} streams
 *   `@derodero24/comprs/streams`
 * @property {typeof import('@derodero24/comprs/node')} node `@derodero24/comprs/node`
 * @property {() => Promise<Main>} importMain How the fixture imports
 *   `@derodero24/comprs` when it needs it later.
 * @property {(specifier: string) => string} resolve How the fixture resolves a
 *   specifier: to a path or a file: URL.
 * @property {Record<string, string>} files The file of the package that each
 *   specifier must resolve to.
 */

/**
 * The functions of the hidden binding of the unified API that the checks
 * call, with the positional parameters that they use.
 *
 * @typedef {object} NextBinding
 * @property {(data: Uint8Array, format: string, level?: number) => Uint8Array} compress
 * @property {(data: Uint8Array, format: string, level?: number) => Promise<Uint8Array>} compressAsync
 * @property {(data: Uint8Array, format?: string) => Uint8Array} decompress
 * @property {(data: Uint8Array, format?: string) => Promise<Uint8Array>} decompressAsync
 */

/**
 * @param {unknown} value
 * @returns {value is NextBinding}
 */
function isNextBinding(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    ['compress', 'compressAsync', 'decompress', 'decompressAsync'].every(
      (name) => typeof Reflect.get(value, name) === 'function',
    )
  );
}

/**
 * A check of an error: a plain Error, or a TypeError for
 * ERR_COMPRS_INVALID_ARG, that carries `code`.
 *
 * @param {string} code
 * @returns {(error: unknown) => boolean}
 */
function codedError(code) {
  const prototype = code === 'ERR_COMPRS_INVALID_ARG' ? TypeError.prototype : Error.prototype;
  return (error) =>
    typeof error === 'object' &&
    error !== null &&
    Object.getPrototypeOf(error) === prototype &&
    Reflect.get(error, 'code') === code;
}

/**
 * Run the checks, print what passed, and throw if any check fails.
 *
 * @param {NativePackage} pkg
 */
export async function checkNativePackage({ main, streams, node, importMain, resolve, files }) {
  const runtime = runtimeName();
  for (const [specifier, file] of Object.entries(files)) {
    const resolved = resolve(specifier);
    const path = resolved.startsWith('file:') ? fileURLToPath(resolved) : resolved;
    assert.equal(path, join(PACKAGE_DIR, file), `${specifier} resolved to ${resolved}`);
  }

  const passed = await checkPackage({ ...main, ...streams, importAsync: importMain });

  const data = new TextEncoder().encode(`Hello from ${runtime}! `.repeat(1000));
  /** @type {Uint8Array[]} */
  const chunks = [];
  await pipeline(
    Readable.from([data]),
    node.createZstdCompressTransform(),
    node.createDecompressTransform(),
    async (/** @type {AsyncIterable<Uint8Array>} */ source) => {
      for await (const chunk of source) {
        chunks.push(chunk);
      }
    },
  );
  assert.deepEqual(new Uint8Array(Buffer.concat(chunks)), data, 'Node.js stream round trip');
  passed.push('Node.js stream round trip');

  // 1.1 MB, which the stream context returns from one call, in memory that
  // the engine owns, and the transform pushes in several chunks that share
  // it, marked as untransferable where the runtime can mark it.
  const large = new TextEncoder().encode('comprs '.repeat(160_000));
  const compressed = main.zstdCompress(large);
  /** @type {Uint8Array[]} */
  const parts = [];
  await pipeline(
    Readable.from([compressed]),
    node.createZstdDecompressTransform(),
    new Writable({
      write(/** @type {Uint8Array} */ chunk, _encoding, callback) {
        parts.push(chunk);
        callback();
      },
    }),
  );
  assert.ok(parts.length > 1, `the transform pushed ${parts.length} chunk`);
  assert.deepEqual(new Uint8Array(Buffer.concat(parts)), large, 'Node.js stream of a large result');
  // Transferring one of those chunks would detach the others: the transfer
  // throws, or the stream fails, but it never ends without them.
  await assert.rejects(
    pipeline(
      Readable.from([compressed]),
      node.createZstdDecompressTransform(),
      new Writable({
        write(/** @type {Uint8Array} */ chunk, _encoding, callback) {
          try {
            structuredClone(chunk, { transfer: [/** @type {ArrayBuffer} */ (chunk.buffer)] });
            callback();
          } catch (error) {
            callback(/** @type {Error} */ (error));
          }
        },
      }),
    ),
    'transferring a chunk of a large result',
  );
  passed.push('Node.js stream of a large result');

  // A method of one context class called on an instance of another must
  // throw. Node.js rejects the call itself ("Illegal invocation"); Deno and
  // Bun run the method, so the addon has to check the receiver, or the
  // method uses the other class's native state and crashes the process.
  assert.throws(
    () => main.ZstdCompressContext.prototype.transform.call(new main.GzipCompressContext(), data),
    /ZstdCompressContext|Illegal invocation/,
  );
  assert.throws(
    () => main.GzipCompressContext.prototype.finish.call(new main.ZstdCompressContext()),
    /GzipCompressContext|Illegal invocation/,
  );
  passed.push('context receiver check');

  // The TypeScript layer of the unified API (#577) reads its native
  // functions from a property of the binding that only Symbol.for() names,
  // which require() returns. Their errors must keep their class and their
  // code in every runtime, whether they are thrown or reject a Promise.
  /** @type {unknown} */
  const binding = createRequire(import.meta.url)('@derodero24/comprs');
  assert.ok(typeof binding === 'object' && binding !== null);
  assert.ok(!Object.keys(binding).includes('next'), 'the binding exports `next`');
  const next = Reflect.get(binding, Symbol.for('@derodero24/comprs/internal'));
  assert.ok(isNextBinding(next), 'the binding has no hidden functions for the unified API');
  const zlib = next.compress(data, 'deflate');
  const output = next.decompress(zlib, 'deflate');
  assert.equal(Object.getPrototypeOf(output), Uint8Array.prototype);
  assert.deepEqual(output, data, 'unified API round trip');
  assert.throws(() => next.compress(data, 'zstd', 23), codedError('ERR_COMPRS_INVALID_ARG'));
  await assert.rejects(next.compressAsync(data, 'zstd', 23), codedError('ERR_COMPRS_INVALID_ARG'));
  const cut = zlib.subarray(0, zlib.length >> 1);
  assert.throws(() => next.decompress(cut, 'deflate'), codedError('ERR_COMPRS_TRUNCATED'));
  await assert.rejects(next.decompressAsync(cut, 'deflate'), codedError('ERR_COMPRS_TRUNCATED'));
  passed.push('unified API binding');

  console.log(`${runtime}: ${passed.length} checks passed (${passed.join(', ')})`);
}

function runtimeName() {
  const { bun, deno } = process.versions;
  if (deno !== undefined) {
    return `Deno ${deno}`;
  }
  return bun === undefined ? `Node.js ${process.versions.node}` : `Bun ${bun}`;
}
