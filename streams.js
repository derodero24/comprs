const { ZstdCompressContext, ZstdDecompressContext } = require('./index.js');

/**
 * Create a streaming zstd compression TransformStream.
 *
 * @param {number} [level=3] Compression level (1-22, or negative for fast mode)
 * @returns {TransformStream<Uint8Array, Uint8Array>}
 */
function createZstdCompressStream(level) {
  const ctx = new ZstdCompressContext(level);
  return new TransformStream({
    transform(chunk, controller) {
      const result = ctx.transform(chunk);
      if (result.byteLength > 0) {
        controller.enqueue(new Uint8Array(result));
      }
    },
    flush(controller) {
      const flushed = ctx.flush();
      if (flushed.byteLength > 0) {
        controller.enqueue(new Uint8Array(flushed));
      }
      const finished = ctx.finish();
      if (finished.byteLength > 0) {
        controller.enqueue(new Uint8Array(finished));
      }
    },
  });
}

/**
 * Create a streaming zstd decompression TransformStream.
 *
 * @returns {TransformStream<Uint8Array, Uint8Array>}
 */
function createZstdDecompressStream() {
  const ctx = new ZstdDecompressContext();
  return new TransformStream({
    transform(chunk, controller) {
      const result = ctx.transform(chunk);
      if (result.byteLength > 0) {
        controller.enqueue(new Uint8Array(result));
      }
    },
    flush(controller) {
      const flushed = ctx.flush();
      if (flushed.byteLength > 0) {
        controller.enqueue(new Uint8Array(flushed));
      }
    },
  });
}

module.exports = { createZstdCompressStream, createZstdDecompressStream };
