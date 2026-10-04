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
      const finished = ctx.finish();
      if (finished.byteLength > 0) {
        controller.enqueue(new Uint8Array(finished));
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
      const finished = ctx.finish();
      if (finished.byteLength > 0) {
        controller.enqueue(new Uint8Array(finished));
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
      const finished = ctx.finish();
      if (finished.byteLength > 0) {
        controller.enqueue(new Uint8Array(finished));
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
 * How much input the auto-detecting stream waits for at most before it
 * decides on the format: detectFormat decodes up to the first 64 KiB to
 * recognize brotli.
 */
const DETECT_LIMIT = 64 * 1024;

/** The length of the zstd and LZ4 magic numbers, the longest ones. */
const MAGIC_LENGTH = 4;

/**
 * Concatenate `chunks`, whose lengths add up to `length`.
 *
 * @param {Uint8Array[]} chunks
 * @param {number} length
 * @returns {Uint8Array}
 */
function concatChunks(chunks, length) {
  if (chunks.length === 1) return chunks[0];
  const data = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.length;
  }
  return data;
}

/**
 * Create a streaming auto-detect decompression TransformStream.
 *
 * Detects the compression format (zstd, gzip, brotli, or lz4) like
 * detectFormat and delegates to the appropriate decompression context.
 * Raw deflate is not supported (no magic bytes to distinguish it).
 *
 * The input is buffered until the format is detected: up to 64 KiB, or the
 * whole input if it is shorter. The stream errors if the format is still
 * unknown then.
 *
 * @param {number} [maxOutputSize] Maximum decompressed output size in bytes
 * @returns {TransformStream<Uint8Array, Uint8Array>}
 */
function createDecompressStream(maxOutputSize) {
  let ctx = null;
  // The input received before the format is detected.
  let buffered = [];
  let bufferedLength = 0;
  // Detection runs once this much input has arrived, then each time the
  // input doubles, so that small chunks do not make it run on every chunk.
  let detectAt = MAGIC_LENGTH;

  function start(format, data, controller) {
    ctx = createDecompressContext(format, maxOutputSize);
    buffered = null;
    enqueueIfNonEmpty(controller, ctx.transform(data));
  }

  return new TransformStream({
    transform(chunk, controller) {
      if (ctx) {
        enqueueIfNonEmpty(controller, ctx.transform(chunk));
        return;
      }

      const copy = new Uint8Array(chunk);
      buffered.push(copy);
      bufferedLength += copy.length;
      if (bufferedLength < detectAt) return;

      const data = concatChunks(buffered, bufferedLength);
      const format = detectFormat(data);
      // More input may still reveal the format, as for the start of a
      // brotli stream or of a skippable frame.
      if (format === 'unknown' && bufferedLength < DETECT_LIMIT) {
        buffered = [data];
        detectAt = Math.min(2 * bufferedLength, DETECT_LIMIT);
        return;
      }
      start(format, data, controller);
    },
    flush(controller) {
      if (!ctx) {
        // The input ended before its format was detected. Empty input has no
        // detectable format and throws.
        const data = concatChunks(buffered, bufferedLength);
        start(detectFormat(data), data, controller);
      }

      enqueueIfNonEmpty(controller, ctx.flush());
      // LZ4 decodes everything in flush(); the other contexts verify in
      // finish() that the input contained the whole stream.
      if (!(ctx instanceof Lz4DecompressContext)) {
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
