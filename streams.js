const {
  BrotliCompressContext,
  BrotliDecompressContext,
  BrotliCompressDictContext,
  BrotliDecompressDictContext,
  ZstdCompressContext,
  ZstdDecompressContext,
  ZstdCompressDictContext,
  ZstdDecompressDictContext,
  GzipCompressContext,
  GzipDecompressContext,
  DeflateCompressContext,
  DeflateDecompressContext,
  Lz4CompressContext,
  Lz4DecompressContext,
  detectFormat,
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
 * @param {number} [maxOutputSize] Maximum decompressed output size in bytes
 * @returns {TransformStream<Uint8Array, Uint8Array>}
 */
function createBrotliDecompressStream(maxOutputSize) {
  const ctx = new BrotliDecompressContext(maxOutputSize);
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
 * @param {number} [maxOutputSize] Maximum decompressed output size in bytes
 * @returns {TransformStream<Uint8Array, Uint8Array>}
 */
function createZstdDecompressStream(maxOutputSize) {
  const ctx = new ZstdDecompressContext(maxOutputSize);
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
 * @param {number} [maxOutputSize] Maximum decompressed output size in bytes
 * @returns {TransformStream<Uint8Array, Uint8Array>}
 */
function createGzipDecompressStream(maxOutputSize) {
  const ctx = new GzipDecompressContext(maxOutputSize);
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
 * @param {number} [maxOutputSize] Maximum decompressed output size in bytes
 * @returns {TransformStream<Uint8Array, Uint8Array>}
 */
function createDeflateDecompressStream(maxOutputSize) {
  const ctx = new DeflateDecompressContext(maxOutputSize);
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
 * Create a streaming brotli compression TransformStream with a custom dictionary.
 *
 * @param {Buffer | Uint8Array} dict Custom dictionary
 * @param {number} [quality=6] Compression quality (0-11)
 * @returns {TransformStream<Uint8Array, Uint8Array>}
 */
function createBrotliCompressDictStream(dict, quality) {
  const ctx = new BrotliCompressDictContext(dict, quality);
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
 * Create a streaming brotli decompression TransformStream with a custom dictionary.
 *
 * @param {Buffer | Uint8Array} dict Custom dictionary (must match the one used for compression)
 * @param {number} [maxOutputSize] Maximum decompressed output size in bytes
 * @returns {TransformStream<Uint8Array, Uint8Array>}
 */
function createBrotliDecompressDictStream(dict, maxOutputSize) {
  const ctx = new BrotliDecompressDictContext(dict, maxOutputSize);
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
 * @param {number} [maxOutputSize] Maximum decompressed output size in bytes
 * @returns {TransformStream<Uint8Array, Uint8Array>}
 */
function createZstdDecompressDictStream(dict, maxOutputSize) {
  const ctx = new ZstdDecompressDictContext(dict, maxOutputSize);
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
 * Create a streaming LZ4 frame compression TransformStream.
 *
 * @returns {TransformStream<Uint8Array, Uint8Array>}
 */
function createLz4CompressStream() {
  const ctx = new Lz4CompressContext();
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
 * Create a streaming LZ4 frame decompression TransformStream.
 *
 * @param {number} [maxOutputSize] Maximum decompressed output size in bytes
 * @returns {TransformStream<Uint8Array, Uint8Array>}
 */
function createLz4DecompressStream(maxOutputSize) {
  const ctx = new Lz4DecompressContext(maxOutputSize);
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

function createDecompressContext(format, maxOutputSize) {
  switch (format) {
    case 'zstd':
      return new ZstdDecompressContext(maxOutputSize);
    case 'gzip':
      return new GzipDecompressContext(maxOutputSize);
    case 'brotli':
      return new BrotliDecompressContext(maxOutputSize);
    case 'lz4':
      return new Lz4DecompressContext(maxOutputSize);
    default:
      throw new Error('unable to detect compression format from stream data');
  }
}

function enqueueIfNonEmpty(controller, result) {
  if (result.byteLength > 0) {
    controller.enqueue(new Uint8Array(result));
  }
}

/**
 * Create a streaming auto-detect decompression TransformStream.
 *
 * Detects the compression format (zstd, gzip, brotli, or lz4) from the first
 * few bytes and delegates to the appropriate decompression context.
 * Raw deflate is not supported (no magic bytes to distinguish it).
 *
 * @param {number} [maxOutputSize] Maximum decompressed output size in bytes
 * @returns {TransformStream<Uint8Array, Uint8Array>}
 */
function createDecompressStream(maxOutputSize) {
  let ctx = null;
  let buffer = null;

  function detectAndReplay(data, controller) {
    ctx = createDecompressContext(detectFormat(data), maxOutputSize);
    buffer = null;
    enqueueIfNonEmpty(controller, ctx.transform(data));
  }

  return new TransformStream({
    transform(chunk, controller) {
      if (ctx) {
        enqueueIfNonEmpty(controller, ctx.transform(chunk));
        return;
      }

      if (buffer === null) {
        buffer = new Uint8Array(chunk);
      } else {
        const combined = new Uint8Array(buffer.length + chunk.length);
        combined.set(buffer);
        combined.set(chunk, buffer.length);
        buffer = combined;
      }

      if (buffer.length < 4) return;

      detectAndReplay(buffer, controller);
    },
    flush(controller) {
      if (!ctx && buffer && buffer.length > 0) {
        detectAndReplay(buffer, controller);
      }
      if (!ctx) return;

      enqueueIfNonEmpty(controller, ctx.flush());
      if (ctx instanceof GzipDecompressContext) {
        enqueueIfNonEmpty(controller, ctx.finish());
      }
    },
  });
}

module.exports = {
  createBrotliCompressStream,
  createBrotliDecompressStream,
  createBrotliCompressDictStream,
  createBrotliDecompressDictStream,
  createZstdCompressStream,
  createZstdDecompressStream,
  createZstdCompressDictStream,
  createZstdDecompressDictStream,
  createGzipCompressStream,
  createGzipDecompressStream,
  createDeflateCompressStream,
  createDeflateDecompressStream,
  createLz4CompressStream,
  createLz4DecompressStream,
  createDecompressStream,
};
