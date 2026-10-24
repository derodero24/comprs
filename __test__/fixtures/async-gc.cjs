// Run by the input ownership tests in async.spec.ts, in a Node.js process of
// its own, as global.gc() needs --expose-gc. Starts zstdCompressAsync calls,
// drops every reference to their inputs and collects garbage while the calls
// run: each call must still return its input, compressed. Exits with code 0
// if all of them do.
'use strict';

const { zstdCompressAsync, zstdDecompress } = require('../../index.js');

const CALLS = 20;
const SIZE = 1 << 20;

/**
 * The input of call `i`: pseudo-random bytes from the generator of
 * deterministicBytes in bench-fixtures.ts, seeded with `i`.
 * @param {number} i
 */
function input(i) {
  const out = Buffer.alloc(SIZE);
  let x = i;
  for (let j = 0; j < SIZE; j++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    out[j] = x >>> 24;
  }
  return out;
}

async function main() {
  if (typeof global.gc !== 'function') {
    throw new Error('run this script with node --expose-gc');
  }
  /** @type {Buffer[] | null} */
  let inputs = Array.from({ length: CALLS }, (_, i) => input(i));
  const calls = inputs.map((data) => zstdCompressAsync(data));
  inputs = null;
  for (let i = 0; i < 3; i++) {
    global.gc();
  }
  const outputs = await Promise.all(calls);
  for (const [i, output] of outputs.entries()) {
    if (!zstdDecompress(output).equals(input(i))) {
      throw new Error(`call ${i} did not return its input, compressed`);
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
  process.exitCode = 1;
});
