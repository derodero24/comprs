import { describe, expect, it } from 'vitest';

import { negotiate } from '../src/negotiate.js';

describe('negotiate', () => {
  it('should return null when no Accept-Encoding header', () => {
    expect(negotiate(undefined)).toBeNull();
  });

  it('should return null for empty header', () => {
    expect(negotiate('')).toBeNull();
  });

  it('should select first preferred encoding accepted by client', () => {
    expect(negotiate('gzip, br, zstd')).toBe('zstd');
  });

  it('should respect server preference order', () => {
    expect(negotiate('gzip, br, zstd', ['br', 'gzip'])).toBe('br');
  });

  it('should respect client quality values', () => {
    // Client strongly prefers br, but server prefers zstd
    // Server preference wins among acceptable encodings
    expect(negotiate('br;q=1.0, zstd;q=0.8', ['zstd', 'br'])).toBe('zstd');
  });

  it('should skip encodings with q=0', () => {
    expect(negotiate('gzip, zstd;q=0', ['zstd', 'gzip'])).toBe('gzip');
  });

  it('should handle wildcard (*)', () => {
    expect(negotiate('*', ['zstd', 'br'])).toBe('zstd');
  });

  it('should handle wildcard with explicitly rejected encoding', () => {
    expect(negotiate('*, zstd;q=0', ['zstd', 'br'])).toBe('br');
  });

  it('should return null when only identity is accepted', () => {
    expect(negotiate('identity')).toBeNull();
  });

  it('should handle case-insensitive encoding names', () => {
    expect(negotiate('GZIP, BR', ['br', 'gzip'])).toBe('br');
  });

  it('should return null when no preferred encoding matches', () => {
    expect(negotiate('gzip', ['zstd', 'br'])).toBeNull();
  });

  it('should handle whitespace in header values', () => {
    expect(negotiate('  gzip , br ; q=0.5 ', ['gzip', 'br'])).toBe('gzip');
  });

  it('should handle single encoding', () => {
    expect(negotiate('gzip')).toBe('gzip');
  });

  it('should use default encodings when none specified', () => {
    // Default order: zstd, br, gzip, deflate
    expect(negotiate('gzip, deflate')).toBe('gzip');
    expect(negotiate('br, gzip')).toBe('br');
    expect(negotiate('zstd')).toBe('zstd');
  });
});
