
import {
  gzipCompress as _gzipCompress,
  gzipDecompress as _gzipDecompress,
  gzipDecompressWithCapacity as _gzipDecompressWithCapacity,
  deflateCompress as _deflateCompress,
  deflateDecompress as _deflateDecompress,
  deflateDecompressWithCapacity as _deflateDecompressWithCapacity,
  brotliCompress as _brotliCompress,
  brotliDecompress as _brotliDecompress,
  brotliDecompressWithCapacity as _brotliDecompressWithCapacity,
  brotliCompressWithDict as _brotliCompressWithDict,
  brotliDecompressWithDict as _brotliDecompressWithDict,
  brotliDecompressWithDictWithCapacity as _brotliDecompressWithDictWithCapacity,
  lz4Compress as _lz4Compress,
  lz4Decompress as _lz4Decompress,
  lz4DecompressWithCapacity as _lz4DecompressWithCapacity,
  zstdCompress as _zstdCompress,
  zstdDecompress as _zstdDecompress,
  zstdDecompressWithCapacity as _zstdDecompressWithCapacity,
  zstdCompressWithDict as _zstdCompressWithDict,
  zstdDecompressWithDict as _zstdDecompressWithDict,
  zstdDecompressWithDictWithCapacity as _zstdDecompressWithDictWithCapacity,
} from './comprs-wasm.js'

/**
 * Concatenate an array of Uint8Array chunks into a single Uint8Array.
 */
function concatChunks(chunks) {
  const totalLength = chunks.reduce((sum, c) => sum + c.byteLength, 0)
  const result = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    result.set(new Uint8Array(chunk.buffer || chunk, chunk.byteOffset, chunk.byteLength), offset)
    offset += chunk.byteLength
  }
  return result
}

// -- Gzip --

export class GzipCompressContext {
  constructor(level) {
    this._level = level
    this._chunks = []
    this._finished = false
  }

  transform(chunk) {
    if (this._finished) throw new Error('gzip stream already finished')
    this._chunks.push(new Uint8Array(chunk.buffer || chunk, chunk.byteOffset, chunk.byteLength))
    return new Uint8Array(0)
  }

  flush() {
    if (this._finished) throw new Error('gzip stream already finished')
    return new Uint8Array(0)
  }

  finish() {
    if (this._finished) throw new Error('gzip stream already finished')
    this._finished = true
    const data = concatChunks(this._chunks)
    this._chunks = []
    return _gzipCompress(data, this._level)
  }
}

export class GzipDecompressContext {
  constructor(maxOutputSize) {
    this._maxOutputSize = maxOutputSize
    this._chunks = []
    this._finished = false
  }

  transform(chunk) {
    if (this._finished) throw new Error('gzip stream already finished')
    this._chunks.push(new Uint8Array(chunk.buffer || chunk, chunk.byteOffset, chunk.byteLength))
    return new Uint8Array(0)
  }

  flush() {
    if (this._finished) throw new Error('gzip stream already finished')
    return new Uint8Array(0)
  }

  finish() {
    if (this._finished) throw new Error('gzip stream already finished')
    this._finished = true
    const data = concatChunks(this._chunks)
    this._chunks = []
    if (this._maxOutputSize != null) {
      return _gzipDecompressWithCapacity(data, this._maxOutputSize)
    }
    return _gzipDecompress(data)
  }
}

// -- Deflate --

export class DeflateCompressContext {
  constructor(level) {
    this._level = level
    this._chunks = []
    this._finished = false
  }

  transform(chunk) {
    if (this._finished) throw new Error('deflate stream already finished')
    this._chunks.push(new Uint8Array(chunk.buffer || chunk, chunk.byteOffset, chunk.byteLength))
    return new Uint8Array(0)
  }

  flush() {
    if (this._finished) throw new Error('deflate stream already finished')
    return new Uint8Array(0)
  }

  finish() {
    if (this._finished) throw new Error('deflate stream already finished')
    this._finished = true
    const data = concatChunks(this._chunks)
    this._chunks = []
    return _deflateCompress(data, this._level)
  }
}

export class DeflateDecompressContext {
  constructor(maxOutputSize) {
    this._maxOutputSize = maxOutputSize
    this._chunks = []
    this._finished = false
  }

  transform(chunk) {
    if (this._finished) throw new Error('deflate stream already finished')
    this._chunks.push(new Uint8Array(chunk.buffer || chunk, chunk.byteOffset, chunk.byteLength))
    return new Uint8Array(0)
  }

  flush() {
    if (this._finished) throw new Error('deflate stream already finished')
    return new Uint8Array(0)
  }

  finish() {
    if (this._finished) throw new Error('deflate stream already finished')
    this._finished = true
    const data = concatChunks(this._chunks)
    this._chunks = []
    if (this._maxOutputSize != null) {
      return _deflateDecompressWithCapacity(data, this._maxOutputSize)
    }
    return _deflateDecompress(data)
  }
}

// -- Brotli --

export class BrotliCompressContext {
  constructor(quality) {
    this._quality = quality
    this._chunks = []
    this._finished = false
  }

  transform(chunk) {
    if (this._finished) throw new Error('brotli stream already finished')
    this._chunks.push(new Uint8Array(chunk.buffer || chunk, chunk.byteOffset, chunk.byteLength))
    return new Uint8Array(0)
  }

  flush() {
    if (this._finished) throw new Error('brotli stream already finished')
    return new Uint8Array(0)
  }

  finish() {
    if (this._finished) throw new Error('brotli stream already finished')
    this._finished = true
    const data = concatChunks(this._chunks)
    this._chunks = []
    return _brotliCompress(data, this._quality)
  }
}

export class BrotliDecompressContext {
  constructor(maxOutputSize) {
    this._maxOutputSize = maxOutputSize
    this._chunks = []
    this._finished = false
  }

  transform(chunk) {
    if (this._finished) throw new Error('brotli stream already finished')
    this._chunks.push(new Uint8Array(chunk.buffer || chunk, chunk.byteOffset, chunk.byteLength))
    return new Uint8Array(0)
  }

  flush() {
    if (this._finished) throw new Error('brotli stream already finished')
    this._finished = true
    const data = concatChunks(this._chunks)
    this._chunks = []
    if (this._maxOutputSize != null) {
      return _brotliDecompressWithCapacity(data, this._maxOutputSize)
    }
    return _brotliDecompress(data)
  }
}

// -- Brotli with dictionary --

export class BrotliCompressDictContext {
  constructor(dict, quality) {
    this._dict = dict
    this._quality = quality
    this._chunks = []
    this._finished = false
  }

  transform(chunk) {
    if (this._finished) throw new Error('brotli dict stream already finished')
    this._chunks.push(new Uint8Array(chunk.buffer || chunk, chunk.byteOffset, chunk.byteLength))
    return new Uint8Array(0)
  }

  flush() {
    if (this._finished) throw new Error('brotli dict stream already finished')
    return new Uint8Array(0)
  }

  finish() {
    if (this._finished) throw new Error('brotli dict stream already finished')
    this._finished = true
    const data = concatChunks(this._chunks)
    this._chunks = []
    return _brotliCompressWithDict(data, this._dict, this._quality)
  }
}

export class BrotliDecompressDictContext {
  constructor(dict, maxOutputSize) {
    this._dict = dict
    this._maxOutputSize = maxOutputSize
    this._chunks = []
    this._finished = false
  }

  transform(chunk) {
    if (this._finished) throw new Error('brotli dict stream already finished')
    this._chunks.push(new Uint8Array(chunk.buffer || chunk, chunk.byteOffset, chunk.byteLength))
    return new Uint8Array(0)
  }

  flush() {
    if (this._finished) throw new Error('brotli dict stream already finished')
    this._finished = true
    const data = concatChunks(this._chunks)
    this._chunks = []
    if (this._maxOutputSize != null) {
      return _brotliDecompressWithDictWithCapacity(data, this._dict, this._maxOutputSize)
    }
    return _brotliDecompressWithDict(data, this._dict)
  }
}

// -- LZ4 --

export class Lz4CompressContext {
  constructor() {
    this._chunks = []
    this._finished = false
  }

  transform(chunk) {
    if (this._finished) throw new Error('lz4 stream already finished')
    this._chunks.push(new Uint8Array(chunk.buffer || chunk, chunk.byteOffset, chunk.byteLength))
    return new Uint8Array(0)
  }

  flush() {
    if (this._finished) throw new Error('lz4 stream already finished')
    return new Uint8Array(0)
  }

  finish() {
    if (this._finished) throw new Error('lz4 stream already finished')
    this._finished = true
    const data = concatChunks(this._chunks)
    this._chunks = []
    return _lz4Compress(data)
  }
}

export class Lz4DecompressContext {
  constructor(maxOutputSize) {
    this._maxOutputSize = maxOutputSize
    this._chunks = []
    this._finished = false
  }

  transform(chunk) {
    if (this._finished) throw new Error('lz4 stream already finished')
    this._chunks.push(new Uint8Array(chunk.buffer || chunk, chunk.byteOffset, chunk.byteLength))
    return new Uint8Array(0)
  }

  flush() {
    if (this._finished) throw new Error('lz4 stream already finished')
    this._finished = true
    const data = concatChunks(this._chunks)
    this._chunks = []
    if (this._maxOutputSize != null) {
      return _lz4DecompressWithCapacity(data, this._maxOutputSize)
    }
    return _lz4Decompress(data)
  }
}

// -- Zstd --

export class ZstdCompressContext {
  constructor(level) {
    this._level = level
    this._chunks = []
    this._finished = false
  }

  transform(chunk) {
    if (this._finished) throw new Error('zstd stream already finished')
    this._chunks.push(new Uint8Array(chunk.buffer || chunk, chunk.byteOffset, chunk.byteLength))
    return new Uint8Array(0)
  }

  flush() {
    if (this._finished) throw new Error('zstd stream already finished')
    return new Uint8Array(0)
  }

  finish() {
    if (this._finished) throw new Error('zstd stream already finished')
    this._finished = true
    const data = concatChunks(this._chunks)
    this._chunks = []
    return _zstdCompress(data, this._level)
  }
}

export class ZstdDecompressContext {
  constructor(maxOutputSize) {
    this._maxOutputSize = maxOutputSize
    this._chunks = []
    this._finished = false
  }

  transform(chunk) {
    if (this._finished) throw new Error('zstd stream already finished')
    this._chunks.push(new Uint8Array(chunk.buffer || chunk, chunk.byteOffset, chunk.byteLength))
    return new Uint8Array(0)
  }

  flush() {
    if (this._finished) throw new Error('zstd stream already finished')
    this._finished = true
    const data = concatChunks(this._chunks)
    this._chunks = []
    if (this._maxOutputSize != null) {
      return _zstdDecompressWithCapacity(data, this._maxOutputSize)
    }
    return _zstdDecompress(data)
  }
}

// -- Zstd with dictionary --

export class ZstdCompressDictContext {
  constructor(dict, level) {
    this._dict = dict
    this._level = level
    this._chunks = []
    this._finished = false
  }

  transform(chunk) {
    if (this._finished) throw new Error('zstd stream already finished')
    this._chunks.push(new Uint8Array(chunk.buffer || chunk, chunk.byteOffset, chunk.byteLength))
    return new Uint8Array(0)
  }

  flush() {
    if (this._finished) throw new Error('zstd stream already finished')
    return new Uint8Array(0)
  }

  finish() {
    if (this._finished) throw new Error('zstd stream already finished')
    this._finished = true
    const data = concatChunks(this._chunks)
    this._chunks = []
    return _zstdCompressWithDict(data, this._dict, this._level)
  }
}

export class ZstdDecompressDictContext {
  constructor(dict, maxOutputSize) {
    this._dict = dict
    this._maxOutputSize = maxOutputSize
    this._chunks = []
    this._finished = false
  }

  transform(chunk) {
    if (this._finished) throw new Error('zstd stream already finished')
    this._chunks.push(new Uint8Array(chunk.buffer || chunk, chunk.byteOffset, chunk.byteLength))
    return new Uint8Array(0)
  }

  flush() {
    if (this._finished) throw new Error('zstd stream already finished')
    this._finished = true
    const data = concatChunks(this._chunks)
    this._chunks = []
    if (this._maxOutputSize != null) {
      return _zstdDecompressWithDictWithCapacity(data, this._dict, this._maxOutputSize)
    }
    return _zstdDecompressWithDict(data, this._dict)
  }
}
