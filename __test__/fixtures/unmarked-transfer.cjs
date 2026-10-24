// Run by node-streams.spec.ts in a Node.js process of its own. Before it
// loads node.js, makes markAsUntransferable() of node:worker_threads throw
// that it is not implemented, as it does in Bun 1.3 and Deno before 2.7.6.
// Then decompresses 1 MiB through the zstd transform, which pushes it in
// several chunks, once into a sink that keeps every chunk and once into a
// sink that transfers every chunk, and prints, as JSON, how many bytes the
// first sink got and the error of the second pipeline.
'use strict';

const { Readable, Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { isArrayBuffer } = require('node:util/types');
const workerThreads = require('node:worker_threads');

workerThreads.markAsUntransferable = () => {
  throw new Error('Not implemented: markAsUntransferable');
};

const { zstdCompress } = require('../../index.js');
const { createZstdDecompressTransform } = require('../../node.js');

const compressed = zstdCompress(Buffer.alloc(1024 * 1024, 'transferred chunks of comprs '));

/**
 * Decompress `compressed` into a sink that calls `take` with each chunk.
 *
 * @param {(chunk: Buffer) => void} take
 * @returns {Promise<void>}
 */
function decompressInto(take) {
  return pipeline(
    Readable.from([compressed]),
    createZstdDecompressTransform(),
    new Writable({
      write(chunk, _encoding, callback) {
        take(chunk);
        callback();
      },
    }),
  );
}

async function main() {
  let kept = 0;
  await decompressInto((chunk) => {
    kept += chunk.byteLength;
  });
  let transferred = 'the pipeline resolved';
  try {
    await decompressInto((chunk) => {
      const { buffer } = chunk;
      if (!isArrayBuffer(buffer)) {
        throw new Error('expected an ArrayBuffer');
      }
      structuredClone(chunk, { transfer: [buffer] });
    });
  } catch (err) {
    transferred = err instanceof Error ? err.message : String(err);
  }
  process.stdout.write(JSON.stringify({ kept, transferred }));
}

// An unexpected rejection ends the process with an error, which fails the
// test.
void main();
