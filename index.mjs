import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const binding = require('./index.js');
const streams = require('./streams.js');

export const {
  version,
  decompress,
  detectFormat,
  brotliCompress,
  brotliDecompress,
  brotliDecompressWithCapacity,
  BrotliCompressContext,
  BrotliDecompressContext,
  zstdCompress,
  zstdDecompress,
  zstdDecompressWithCapacity,
  ZstdCompressContext,
  ZstdDecompressContext,
  gzipCompress,
  gzipDecompress,
  gzipDecompressWithCapacity,
  deflateCompress,
  deflateDecompress,
  deflateDecompressWithCapacity,
  GzipCompressContext,
  GzipDecompressContext,
  DeflateCompressContext,
  DeflateDecompressContext,
} = binding;

export const {
  createBrotliCompressStream,
  createBrotliDecompressStream,
  createZstdCompressStream,
  createZstdDecompressStream,
  createGzipCompressStream,
  createGzipDecompressStream,
  createDeflateCompressStream,
  createDeflateDecompressStream,
} = streams;
