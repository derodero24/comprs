const {
  BrotliCompressContext,
  BrotliDecompressContext,
  ZstdCompressContext,
  ZstdDecompressContext,
  ZstdCompressDictContext,
  ZstdDecompressDictContext,
  GzipCompressContext,
  GzipDecompressContext,
  DeflateCompressContext,
  DeflateDecompressContext,
} = require('./index.js');

/**
 * Create a streaming brotli compression TransformStream.
 *
 * @param {number} [quality=6] Compression quality (0-11)
 * @returns {TransformStream<Uint8Array, Uint8Array>}
 */
function createBrotliCompressStream(quality) {
  const ctx = new BrotliCompressContext(quality);
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
 * Create a streaming brotli decompression TransformStream.
 *
 * @returns {TransformStream<Uint8Array, Uint8Array>}
 */
function createBrotliDecompressStream() {
  const ctx = new BrotliDecompressContext();
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

/**
 * Create a streaming gzip compression TransformStream.
 *
 * @param {number} [level=6] Compression level (0-9)
 * @returns {TransformStream<Uint8Array, Uint8Array>}
 */
function createGzipCompressStream(level) {
  const ctx = new GzipCompressContext(level);
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
 * Create a streaming gzip decompression TransformStream.
 *
 * @returns {TransformStream<Uint8Array, Uint8Array>}
 */
function createGzipDecompressStream() {
  const ctx = new GzipDecompressContext();
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
 * Create a streaming raw deflate compression TransformStream.
 *
 * @param {number} [level=6] Compression level (0-9)
 * @returns {TransformStream<Uint8Array, Uint8Array>}
 */
function createDeflateCompressStream(level) {
  const ctx = new DeflateCompressContext(level);
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
 * Create a streaming raw deflate decompression TransformStream.
 *
 * @returns {TransformStream<Uint8Array, Uint8Array>}
 */
function createDeflateDecompressStream() {
  const ctx = new DeflateDecompressContext();
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
 * Create a streaming zstd compression TransformStream with a pre-trained dictionary.
 *
 * @param {Buffer | Uint8Array} dict Pre-trained dictionary
 * @param {number} [level=3] Compression level (1-22, or negative for fast mode)
 * @returns {TransformStream<Uint8Array, Uint8Array>}
 */
function createZstdCompressDictStream(dict, level) {
  const ctx = new ZstdCompressDictContext(dict, level);
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
 * Create a streaming zstd decompression TransformStream with a pre-trained dictionary.
 *
 * @param {Buffer | Uint8Array} dict Pre-trained dictionary (must match the one used for compression)
 * @returns {TransformStream<Uint8Array, Uint8Array>}
 */
function createZstdDecompressDictStream(dict) {
  const ctx = new ZstdDecompressDictContext(dict);
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

module.exports = {
  createBrotliCompressStream,
  createBrotliDecompressStream,
  createZstdCompressStream,
  createZstdDecompressStream,
  createZstdCompressDictStream,
  createZstdDecompressDictStream,
  createGzipCompressStream,
  createGzipDecompressStream,
  createDeflateCompressStream,
  createDeflateDecompressStream,
};
