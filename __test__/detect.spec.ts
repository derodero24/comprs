import { describe, expect, it } from 'vitest';
import {
  brotliCompress,
  decompress,
  deflateCompress,
  detectFormat,
  gzipCompress,
  zstdCompress,
} from '../index.js';

describe('detectFormat', () => {
  it('should detect zstd format', () => {
    const data = Buffer.from('test data for zstd detection');
    const compressed = zstdCompress(data);
    expect(detectFormat(compressed)).toBe('zstd');
  });

  it('should detect gzip format', () => {
    const data = Buffer.from('test data for gzip detection');
    const compressed = gzipCompress(data);
    expect(detectFormat(compressed)).toBe('gzip');
  });

  it('should detect brotli format', () => {
    const data = Buffer.from('test data for brotli detection');
    const compressed = brotliCompress(data);
    expect(detectFormat(compressed)).toBe('brotli');
  });

  it('should return unknown for raw deflate (no magic bytes)', () => {
    const data = Buffer.from('test data for deflate');
    const compressed = deflateCompress(data);
    // Raw deflate has no magic bytes, cannot be auto-detected
    const format = detectFormat(compressed);
    expect(['unknown', 'brotli']).toContain(format);
  });

  it('should return unknown for plain text', () => {
    const data = Buffer.from('this is not compressed data');
    expect(detectFormat(data)).toBe('unknown');
  });

  it('should return unknown for empty data', () => {
    expect(detectFormat(Buffer.alloc(0))).toBe('unknown');
  });

  it('should accept Uint8Array input', () => {
    const data = new Uint8Array(Buffer.from('test'));
    const compressed = zstdCompress(data);
    expect(detectFormat(compressed)).toBe('zstd');
  });
});

describe('decompress (auto-detect)', () => {
  const original = Buffer.from('Hello, auto-detect decompression!');

  it('should auto-decompress zstd data', () => {
    const compressed = zstdCompress(original);
    const result = decompress(compressed);
    expect(Buffer.compare(result, original)).toBe(0);
  });

  it('should auto-decompress gzip data', () => {
    const compressed = gzipCompress(original);
    const result = decompress(compressed);
    expect(Buffer.compare(result, original)).toBe(0);
  });

  it('should auto-decompress brotli data', () => {
    const compressed = brotliCompress(original);
    const result = decompress(compressed);
    expect(Buffer.compare(result, original)).toBe(0);
  });

  it('should throw on unknown format', () => {
    const data = Buffer.from('not compressed');
    expect(() => decompress(data)).toThrow(/unable to detect compression format/);
  });

  it('should throw on empty data', () => {
    expect(() => decompress(Buffer.alloc(0))).toThrow(/unable to detect compression format/);
  });

  it('should round-trip large zstd data', () => {
    const large = Buffer.alloc(100_000);
    for (let i = 0; i < large.length; i++) large[i] = i % 256;
    const compressed = zstdCompress(large);
    const result = decompress(compressed);
    expect(Buffer.compare(result, large)).toBe(0);
  });

  it('should round-trip large gzip data', () => {
    const large = Buffer.alloc(100_000);
    for (let i = 0; i < large.length; i++) large[i] = i % 256;
    const compressed = gzipCompress(large);
    const result = decompress(compressed);
    expect(Buffer.compare(result, large)).toBe(0);
  });

  it('should round-trip large brotli data', () => {
    const large = Buffer.alloc(100_000);
    for (let i = 0; i < large.length; i++) large[i] = i % 256;
    const compressed = brotliCompress(large);
    const result = decompress(compressed);
    expect(Buffer.compare(result, large)).toBe(0);
  });

  it('should accept Uint8Array input', () => {
    const compressed = zstdCompress(original);
    const uint8 = new Uint8Array(compressed);
    const result = decompress(uint8);
    expect(Buffer.compare(result, original)).toBe(0);
  });
});
