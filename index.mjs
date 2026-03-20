import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const binding = require('./index.js');
const streams = require('./streams.js');

export const {
  version,
  brotliCompress,
  brotliDecompress,
  brotliDecompressWithCapacity,
  brotliCompressAsync,
  brotliDecompressAsync,
  BrotliCompressContext,
  BrotliDecompressContext,
  zstdCompress,
  zstdDecompress,
  zstdDecompressWithCapacity,
  zstdCompressAsync,
  zstdDecompressAsync,
  ZstdCompressContext,
  ZstdDecompressContext,
  decompress,
  detectFormat,
  gzipCompress,
  gzipDecompress,
  gzipDecompressWithCapacity,
  gzipCompressAsync,
  gzipDecompressAsync,
  deflateCompress,
  deflateDecompress,
  deflateDecompressWithCapacity,
  deflateCompressAsync,
  deflateDecompressAsync,
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
