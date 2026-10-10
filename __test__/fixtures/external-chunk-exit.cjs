// Run by node-streams.spec.ts in a Node.js process of its own. Decompresses
// 4 MiB of zeros through the zstd transform, which gets them from one call
// of the stream context, in the memory of the addon, keeps the first chunk
// until the end, and exits normally. With the argument `worker`, a Worker
// does this, and the main thread waits for it to exit. The main thread then
// prints, as JSON, how many bytes the pipeline delivered and, for a Worker,
// its exit code.
//
// Node.js frees the memory of an external buffer that is still alive when
// the process or the Worker exits, and detaches the buffer first, without a
// detach key. On Node.js 24, markAsUntransferable() sets one, so this
// aborted the process ("FATAL ERROR: v8::FromJust Maybe value is Nothing")
// when the transform marked such a result as untransferable.
'use strict';

const { Readable, Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { isMainThread, parentPort, Worker } = require('node:worker_threads');

const { zstdCompress } = require('../../index.js');
const { createZstdDecompressTransform } = require('../../node.js');

const SIZE = 4 * 1024 * 1024;

/**
 * The first chunk, which stays alive until the thread exits.
 *
 * @type {Buffer[]}
 */
const kept = [];

/**
 * Decompress SIZE bytes of zeros, keep the first chunk, and return how many
 * bytes the pipeline delivered.
 *
 * @returns {Promise<number>}
 */
async function decompress() {
  let received = 0;
  await pipeline(
    Readable.from([zstdCompress(Buffer.alloc(SIZE))]),
    createZstdDecompressTransform(),
    new Writable({
      write(chunk, _encoding, callback) {
        if (kept.length === 0) {
          kept.push(chunk);
        }
        received += chunk.byteLength;
        callback();
      },
    }),
  );
  return received;
}

// An unexpected rejection ends the thread with an error, which fails the
// test.
if (!isMainThread) {
  void decompress().then((received) => parentPort?.postMessage(received));
} else if (process.argv[2] === 'worker') {
  const worker = new Worker(__filename);
  let received = 0;
  worker.on('message', (/** @type {number} */ bytes) => {
    received = bytes;
  });
  worker.on('exit', (exitCode) => {
    process.stdout.write(JSON.stringify({ received, exitCode }));
  });
} else {
  void decompress().then((received) => {
    process.stdout.write(JSON.stringify({ received }));
  });
}
