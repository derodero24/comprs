import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { gzipCompress, gzipCompressWithHeader, gzipDecompress, gzipReadHeader } from '../index.js';

describe('gzipCompressWithHeader', () => {
  it('should compress with filename', () => {
    const data = Buffer.from('Hello, gzip header!');
    const compressed = gzipCompressWithHeader(data, { filename: 'hello.txt' });
    const decompressed = gzipDecompress(compressed);
    expect(decompressed).toEqual(data);

    const header = gzipReadHeader(compressed);
    expect(header.filename).toBe('hello.txt');
  });

  it('should compress with mtime', () => {
    const data = Buffer.from('Mtime test');
    const mtime = 1700000000;
    const compressed = gzipCompressWithHeader(data, { mtime });
    const header = gzipReadHeader(compressed);
    expect(header.mtime).toBe(mtime);
  });

  it('should compress with both filename and mtime', () => {
    const data = Buffer.from('Both fields test');
    const compressed = gzipCompressWithHeader(data, {
      filename: 'test.dat',
      mtime: 1700000000,
    });
    const header = gzipReadHeader(compressed);
    expect(header.filename).toBe('test.dat');
    expect(header.mtime).toBe(1700000000);
  });

  it('should compress with empty header (defaults)', () => {
    const data = Buffer.from('Default header test');
    const compressed = gzipCompressWithHeader(data, {});
    const decompressed = gzipDecompress(compressed);
    expect(decompressed).toEqual(data);
  });

  it('should accept custom compression level', () => {
    const data = Buffer.from('Level test '.repeat(100));
    const c1 = gzipCompressWithHeader(data, { filename: 'fast.txt' }, 1);
    const c9 = gzipCompressWithHeader(data, { filename: 'best.txt' }, 9);
    expect(gzipDecompress(c1)).toEqual(data);
    expect(gzipDecompress(c9)).toEqual(data);
    expect(c9.length).toBeLessThanOrEqual(c1.length);
  });

  it('should throw on invalid level', () => {
    const data = Buffer.from('test');
    expect(() => gzipCompressWithHeader(data, {}, 10)).toThrow(/level must be between 0 and 9/);
  });
});

describe('gzipReadHeader', () => {
  it('should read header from standard gzipCompress output', () => {
    const compressed = gzipCompress(Buffer.from('test'));
    const header = gzipReadHeader(compressed);
    expect(header.mtime).toBe(0);
    expect(header.filename).toBeUndefined();
    expect(header.comment).toBeUndefined();
    expect(typeof header.os).toBe('number');
  });

  it('should read header from Node.js zlib output', () => {
    const compressed = gzipSync(Buffer.from('node test'));
    const header = gzipReadHeader(compressed);
    expect(typeof header.mtime).toBe('number');
    expect(typeof header.os).toBe('number');
  });

  it('should throw on invalid data', () => {
    expect(() => gzipReadHeader(Buffer.from('not gzip'))).toThrow();
  });

  it('should throw on empty data', () => {
    expect(() => gzipReadHeader(Buffer.alloc(0))).toThrow();
  });
});
