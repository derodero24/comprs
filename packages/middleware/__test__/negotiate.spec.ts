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

  it('should read the q parameter case-insensitively', () => {
    expect(negotiate('gzip;Q=0', ['gzip'])).toBeNull();
    expect(negotiate('br;Q=0, gzip', ['br', 'gzip'])).toBe('gzip');
    expect(negotiate('gzip; Q=0.5', ['gzip'])).toBe('gzip');
  });

  it.each(['q=2', 'q=1.001', 'q=-1', 'q=0.0001', 'q=.5', 'q=abc', 'q=', 'q', 'q=0.5x'])(
    'should ignore an element with the invalid weight %s',
    (weight) => {
      expect(negotiate(`gzip;${weight}`, ['gzip'])).toBeNull();
      expect(negotiate(`br;${weight}, gzip`, ['br', 'gzip'])).toBe('gzip');
    },
  );

  it.each([
    ['q=1', 'gzip'],
    ['q=1.', 'gzip'],
    ['q=1.000', 'gzip'],
    ['q=0.001', 'gzip'],
    ['q=0', null],
    ['q=0.', null],
    ['q=0.000', null],
  ])('should accept the valid weight %s', (weight, expected) => {
    expect(negotiate(`gzip;${weight}`, ['gzip'])).toBe(expected);
  });

  it('should apply * only to encodings that are not listed', () => {
    expect(negotiate('*;q=0, gzip', ['zstd', 'gzip'])).toBe('gzip');
    expect(negotiate('*;q=0', ['zstd', 'gzip'])).toBeNull();
    expect(negotiate('zstd;q=0, *;q=0.1', ['zstd', 'gzip'])).toBe('gzip');
  });

  it('should keep the highest weight of an encoding listed twice', () => {
    expect(negotiate('gzip;q=0, gzip;q=0.5', ['gzip'])).toBe('gzip');
    expect(negotiate('gzip;q=0.5, gzip;q=0', ['gzip'])).toBe('gzip');
  });

  it('should not treat identity as an encoding to apply', () => {
    expect(negotiate('identity, gzip;q=0', ['gzip'])).toBeNull();
    expect(negotiate('identity;q=0, gzip', ['gzip'])).toBe('gzip');
  });

  it('should ignore empty list elements and unknown codings', () => {
    expect(negotiate(', ,gzip,,', ['gzip'])).toBe('gzip');
    expect(negotiate('compress, x-unknown', ['gzip'])).toBeNull();
  });

  it('should use client weights only to rule encodings out', () => {
    // Server order decides among acceptable encodings, as documented.
    expect(negotiate('gzip;q=1, br;q=0.1', ['br', 'gzip'])).toBe('br');
  });
});
