import {
  brotliCompress as _brotliCompress,
  brotliCompressWithDict as _brotliCompressWithDict,
  brotliDecompress as _brotliDecompress,
  brotliDecompressWithCapacity as _brotliDecompressWithCapacity,
  brotliDecompressWithDict as _brotliDecompressWithDict,
  brotliDecompressWithDictWithCapacity as _brotliDecompressWithDictWithCapacity,
  deflateCompress as _deflateCompress,
  deflateDecompress as _deflateDecompress,
  deflateDecompressWithCapacity as _deflateDecompressWithCapacity,
  gzipCompress as _gzipCompress,
  gzipDecompress as _gzipDecompress,
  gzipDecompressWithCapacity as _gzipDecompressWithCapacity,
  lz4Compress as _lz4Compress,
  lz4Decompress as _lz4Decompress,
  lz4DecompressWithCapacity as _lz4DecompressWithCapacity,
  zstdCompress as _zstdCompress,
  zstdCompressWithDict as _zstdCompressWithDict,
  zstdDecompress as _zstdDecompress,
  zstdDecompressWithCapacity as _zstdDecompressWithCapacity,
  zstdDecompressWithDict as _zstdDecompressWithDict,
  zstdDecompressWithDictWithCapacity as _zstdDecompressWithDictWithCapacity,
} from './comprs-wasm.js';

/**
 * Concatenate an array of Uint8Array chunks into a single Uint8Array.
 */
function concatChunks(chunks) {
  const totalLength = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(new Uint8Array(chunk.buffer || chunk, chunk.byteOffset, chunk.byteLength), offset);
    offset += chunk.byteLength;
  }
  return result;
}

// -- Gzip --

export class GzipCompressContext {
  constructor(level) {
    this._level = level;
    this._chunks = [];
    this._finished = false;
  }

  transform(chunk) {
    if (this._finished) throw new Error('gzip stream already finished');
    this._chunks.push(new Uint8Array(chunk.buffer || chunk, chunk.byteOffset, chunk.byteLength));
    return new Uint8Array(0);
  }

  flush() {
    if (this._finished) throw new Error('gzip stream already finished');
    return new Uint8Array(0);
  }

  finish() {
    if (this._finished) throw new Error('gzip stream already finished');
    this._finished = true;
    const data = concatChunks(this._chunks);
    this._chunks = [];
    return _gzipCompress(data, this._level);
  }
}

export class GzipDecompressContext {
  constructor(maxOutputSize) {
    this._maxOutputSize = maxOutputSize;
    this._chunks = [];
    this._finished = false;
  }

  transform(chunk) {
    if (this._finished) throw new Error('gzip stream already finished');
    this._chunks.push(new Uint8Array(chunk.buffer || chunk, chunk.byteOffset, chunk.byteLength));
    return new Uint8Array(0);
  }

  flush() {
    if (this._finished) throw new Error('gzip stream already finished');
    return new Uint8Array(0);
  }

  finish() {
    if (this._finished) throw new Error('gzip stream already finished');
    this._finished = true;
    const data = concatChunks(this._chunks);
    this._chunks = [];
    if (this._maxOutputSize != null) {
      return _gzipDecompressWithCapacity(data, this._maxOutputSize);
    }
    return _gzipDecompress(data);
  }
}

// -- Deflate --

export class DeflateCompressContext {
  constructor(level) {
    this._level = level;
    this._chunks = [];
    this._finished = false;
  }

  transform(chunk) {
    if (this._finished) throw new Error('deflate stream already finished');
    this._chunks.push(new Uint8Array(chunk.buffer || chunk, chunk.byteOffset, chunk.byteLength));
    return new Uint8Array(0);
  }

  flush() {
    if (this._finished) throw new Error('deflate stream already finished');
    return new Uint8Array(0);
  }

  finish() {
    if (this._finished) throw new Error('deflate stream already finished');
    this._finished = true;
    const data = concatChunks(this._chunks);
    this._chunks = [];
    return _deflateCompress(data, this._level);
  }
}

export class DeflateDecompressContext {
  constructor(maxOutputSize) {
    this._maxOutputSize = maxOutputSize;
    this._chunks = [];
    this._finished = false;
  }

  transform(chunk) {
    if (this._finished) throw new Error('deflate stream already finished');
    this._chunks.push(new Uint8Array(chunk.buffer || chunk, chunk.byteOffset, chunk.byteLength));
    return new Uint8Array(0);
  }

  flush() {
    if (this._finished) throw new Error('deflate stream already finished');
    return new Uint8Array(0);
  }

  finish() {
    if (this._finished) throw new Error('deflate stream already finished');
    this._finished = true;
    const data = concatChunks(this._chunks);
    this._chunks = [];
    if (this._maxOutputSize != null) {
      return _deflateDecompressWithCapacity(data, this._maxOutputSize);
    }
    return _deflateDecompress(data);
  }
}

// -- Brotli --

export class BrotliCompressContext {
  constructor(quality) {
    this._quality = quality;
    this._chunks = [];
    this._finished = false;
  }

  transform(chunk) {
    if (this._finished) throw new Error('brotli stream already finished');
    this._chunks.push(new Uint8Array(chunk.buffer || chunk, chunk.byteOffset, chunk.byteLength));
    return new Uint8Array(0);
  }

  flush() {
    if (this._finished) throw new Error('brotli stream already finished');
    return new Uint8Array(0);
  }

  finish() {
    if (this._finished) throw new Error('brotli stream already finished');
    this._finished = true;
    const data = concatChunks(this._chunks);
    this._chunks = [];
    return _brotliCompress(data, this._quality);
  }
}

export class BrotliDecompressContext {
  constructor(maxOutputSize) {
    this._maxOutputSize = maxOutputSize;
    this._chunks = [];
    this._state = 'open';
  }

  transform(chunk) {
    if (this._state !== 'open') throw new Error('brotli stream already finished');
    this._chunks.push(new Uint8Array(chunk.buffer || chunk, chunk.byteOffset, chunk.byteLength));
    return new Uint8Array(0);
  }

  flush() {
    if (this._state !== 'open') throw new Error('brotli stream already finished');
    this._state = 'finished';
    const data = concatChunks(this._chunks);
    this._chunks = [];
    const result =
      this._maxOutputSize != null
        ? _brotliDecompressWithCapacity(data, this._maxOutputSize)
        : _brotliDecompress(data);
    this._state = 'decoded';
    return result;
  }

  finish() {
    // flush() decodes and verifies the whole stream, so nothing is left after it.
    const result = this._state === 'open' ? this.flush() : new Uint8Array(0);
    if (this._state !== 'decoded') throw new Error('brotli stream already finished');
    this._state = 'finished';
    return result;
  }
}

// -- Brotli with dictionary --

export class BrotliCompressDictContext {
  constructor(dict, quality) {
    this._dict = dict;
    this._quality = quality;
    this._chunks = [];
    this._finished = false;
  }

  transform(chunk) {
    if (this._finished) throw new Error('brotli dict stream already finished');
    this._chunks.push(new Uint8Array(chunk.buffer || chunk, chunk.byteOffset, chunk.byteLength));
    return new Uint8Array(0);
  }

  flush() {
    if (this._finished) throw new Error('brotli dict stream already finished');
    return new Uint8Array(0);
  }

  finish() {
    if (this._finished) throw new Error('brotli dict stream already finished');
    this._finished = true;
    const data = concatChunks(this._chunks);
    this._chunks = [];
    return _brotliCompressWithDict(data, this._dict, this._quality);
  }
}

export class BrotliDecompressDictContext {
  constructor(dict, maxOutputSize) {
    this._dict = dict;
    this._maxOutputSize = maxOutputSize;
    this._chunks = [];
    this._state = 'open';
  }

  transform(chunk) {
    if (this._state !== 'open') throw new Error('brotli dict stream already finished');
    this._chunks.push(new Uint8Array(chunk.buffer || chunk, chunk.byteOffset, chunk.byteLength));
    return new Uint8Array(0);
  }

  flush() {
    if (this._state !== 'open') throw new Error('brotli dict stream already finished');
    this._state = 'finished';
    const data = concatChunks(this._chunks);
    this._chunks = [];
    const result =
      this._maxOutputSize != null
        ? _brotliDecompressWithDictWithCapacity(data, this._dict, this._maxOutputSize)
        : _brotliDecompressWithDict(data, this._dict);
    this._state = 'decoded';
    return result;
  }

  finish() {
    // flush() decodes and verifies the whole stream, so nothing is left after it.
    const result = this._state === 'open' ? this.flush() : new Uint8Array(0);
    if (this._state !== 'decoded') throw new Error('brotli dict stream already finished');
    this._state = 'finished';
    return result;
  }
}

// -- LZ4 --

export class Lz4CompressContext {
  constructor() {
    this._chunks = [];
    this._finished = false;
  }

  transform(chunk) {
    if (this._finished) throw new Error('lz4 stream already finished');
    this._chunks.push(new Uint8Array(chunk.buffer || chunk, chunk.byteOffset, chunk.byteLength));
    return new Uint8Array(0);
  }

  flush() {
    if (this._finished) throw new Error('lz4 stream already finished');
    return new Uint8Array(0);
  }

  finish() {
    if (this._finished) throw new Error('lz4 stream already finished');
    this._finished = true;
    const data = concatChunks(this._chunks);
    this._chunks = [];
    return _lz4Compress(data);
  }
}

export class Lz4DecompressContext {
  constructor(maxOutputSize) {
    this._maxOutputSize = maxOutputSize;
    this._chunks = [];
    this._finished = false;
  }

  transform(chunk) {
    if (this._finished) throw new Error('lz4 stream already finished');
    this._chunks.push(new Uint8Array(chunk.buffer || chunk, chunk.byteOffset, chunk.byteLength));
    return new Uint8Array(0);
  }

  flush() {
    if (this._finished) throw new Error('lz4 stream already finished');
    this._finished = true;
    const data = concatChunks(this._chunks);
    this._chunks = [];
    if (this._maxOutputSize != null) {
      return _lz4DecompressWithCapacity(data, this._maxOutputSize);
    }
    return _lz4Decompress(data);
  }
}

// -- Zstd --

export class ZstdCompressContext {
  constructor(level) {
    this._level = level;
    this._chunks = [];
    this._finished = false;
  }

  transform(chunk) {
    if (this._finished) throw new Error('zstd stream already finished');
    this._chunks.push(new Uint8Array(chunk.buffer || chunk, chunk.byteOffset, chunk.byteLength));
    return new Uint8Array(0);
  }

  flush() {
    if (this._finished) throw new Error('zstd stream already finished');
    return new Uint8Array(0);
  }

  finish() {
    if (this._finished) throw new Error('zstd stream already finished');
    this._finished = true;
    const data = concatChunks(this._chunks);
    this._chunks = [];
    return _zstdCompress(data, this._level);
  }
}

export class ZstdDecompressContext {
  constructor(maxOutputSize) {
    this._maxOutputSize = maxOutputSize;
    this._chunks = [];
    this._state = 'open';
  }

  transform(chunk) {
    if (this._state !== 'open') throw new Error('zstd stream already finished');
    this._chunks.push(new Uint8Array(chunk.buffer || chunk, chunk.byteOffset, chunk.byteLength));
    return new Uint8Array(0);
  }

  flush() {
    if (this._state !== 'open') throw new Error('zstd stream already finished');
    this._state = 'finished';
    const data = concatChunks(this._chunks);
    this._chunks = [];
    const result =
      this._maxOutputSize != null
        ? _zstdDecompressWithCapacity(data, this._maxOutputSize)
        : _zstdDecompress(data);
    this._state = 'decoded';
    return result;
  }

  finish() {
    // flush() decodes and verifies the whole stream, so nothing is left after it.
    const result = this._state === 'open' ? this.flush() : new Uint8Array(0);
    if (this._state !== 'decoded') throw new Error('zstd stream already finished');
    this._state = 'finished';
    return result;
  }
}

// -- Zstd with dictionary --

export class ZstdCompressDictContext {
  constructor(dict, level) {
    this._dict = dict;
    this._level = level;
    this._chunks = [];
    this._finished = false;
  }

  transform(chunk) {
    if (this._finished) throw new Error('zstd stream already finished');
    this._chunks.push(new Uint8Array(chunk.buffer || chunk, chunk.byteOffset, chunk.byteLength));
    return new Uint8Array(0);
  }

  flush() {
    if (this._finished) throw new Error('zstd stream already finished');
    return new Uint8Array(0);
  }

  finish() {
    if (this._finished) throw new Error('zstd stream already finished');
    this._finished = true;
    const data = concatChunks(this._chunks);
    this._chunks = [];
    return _zstdCompressWithDict(data, this._dict, this._level);
  }
}

export class ZstdDecompressDictContext {
  constructor(dict, maxOutputSize) {
    this._dict = dict;
    this._maxOutputSize = maxOutputSize;
    this._chunks = [];
    this._state = 'open';
  }

  transform(chunk) {
    if (this._state !== 'open') throw new Error('zstd stream already finished');
    this._chunks.push(new Uint8Array(chunk.buffer || chunk, chunk.byteOffset, chunk.byteLength));
    return new Uint8Array(0);
  }

  flush() {
    if (this._state !== 'open') throw new Error('zstd stream already finished');
    this._state = 'finished';
    const data = concatChunks(this._chunks);
    this._chunks = [];
    const result =
      this._maxOutputSize != null
        ? _zstdDecompressWithDictWithCapacity(data, this._dict, this._maxOutputSize)
        : _zstdDecompressWithDict(data, this._dict);
    this._state = 'decoded';
    return result;
  }

  finish() {
    // flush() decodes and verifies the whole stream, so nothing is left after it.
    const result = this._state === 'open' ? this.flush() : new Uint8Array(0);
    if (this._state !== 'decoded') throw new Error('zstd stream already finished');
    this._state = 'finished';
    return result;
  }
}
