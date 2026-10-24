import { describe, expect, it } from 'vitest';

import { resolveOptions, type SharedOptions } from '../src/options.js';
import { DEFAULT_ENCODINGS, DEFAULT_THRESHOLD } from '../src/shared.js';

describe('resolveOptions', () => {
  it('should apply the defaults', () => {
    expect(resolveOptions({})).toEqual({
      encodings: DEFAULT_ENCODINGS,
      threshold: DEFAULT_THRESHOLD,
      level: undefined,
    });
  });

  it('should keep valid options', () => {
    const settings = resolveOptions({
      encodings: ['br', 'gzip'],
      threshold: 0,
      level: { zstd: -5, br: 11, gzip: 0, deflate: 9 },
      filter: () => true,
    });
    expect(settings).toEqual({
      encodings: ['br', 'gzip'],
      threshold: 0,
      level: { zstd: -5, br: 11, gzip: 0, deflate: 9 },
    });
  });

  it('should accept the zstd levels RFC 9659 allows', () => {
    for (const zstd of [-131072, -1, 0, 1, 19]) {
      expect(resolveOptions({ level: { zstd } }).level).toEqual({ zstd });
    }
  });

  it('should copy the levels, so later changes cannot bypass the checks', () => {
    const level = { gzip: 6 };
    const settings = resolveOptions({ level });
    level.gzip = 99;
    expect(settings.level).toEqual({ gzip: 6 });
  });

  it('should skip levels that are undefined', () => {
    // @ts-expect-error: allowed without exactOptionalPropertyTypes and in JavaScript
    expect(resolveOptions({ level: { gzip: undefined } }).level).toEqual({});
  });

  const invalid: { label: string; options: SharedOptions; error: RegExp }[] = [
    { label: 'gzip level 99', options: { level: { gzip: 99 } }, error: /level\.gzip .* 0 to 9/ },
    { label: 'gzip level -1', options: { level: { gzip: -1 } }, error: /level\.gzip/ },
    { label: 'deflate level 10', options: { level: { deflate: 10 } }, error: /level\.deflate/ },
    { label: 'brotli level 12', options: { level: { br: 12 } }, error: /level\.br .* 0 to 11/ },
    { label: 'brotli level 1.5', options: { level: { br: 1.5 } }, error: /got 1\.5/ },
    { label: 'gzip level NaN', options: { level: { gzip: Number.NaN } }, error: /got NaN/ },
    { label: 'zstd level 20', options: { level: { zstd: 20 } }, error: /to 19, got 20.*RFC 9659/ },
    { label: 'zstd level 22', options: { level: { zstd: 22 } }, error: /level\.zstd/ },
    {
      label: 'zstd level -131073',
      options: { level: { zstd: -131073 } },
      error: /level\.zstd/,
    },
    { label: 'threshold NaN', options: { threshold: Number.NaN }, error: /threshold .* got NaN/ },
    {
      label: 'threshold Infinity',
      options: { threshold: Number.POSITIVE_INFINITY },
      error: /threshold/,
    },
    { label: 'threshold -1', options: { threshold: -1 }, error: /threshold .* got -1/ },
    { label: 'no encodings', options: { encodings: [] }, error: /encodings must not be empty/ },
    { label: 'a filter that is no function', options: { filter: true }, error: /filter/ },
  ];

  it.each(invalid)('should reject $label', ({ options, error }) => {
    expect(() => resolveOptions(options)).toThrow(error);
  });

  // What JavaScript callers can pass despite the types.
  const untyped: { label: string; options: SharedOptions; error: RegExp }[] = [
    // @ts-expect-error: lz4 is not an HTTP content coding
    { label: 'an unsupported encoding', options: { encodings: ['lz4'] }, error: /"lz4"/ },
    // @ts-expect-error: encodings is an array
    { label: 'encodings that are no array', options: { encodings: 'gzip' }, error: /array/ },
    // @ts-expect-error: lz4 is not an HTTP content coding
    { label: 'a level for lz4', options: { level: { lz4: 1 } }, error: /level\.lz4/ },
    // @ts-expect-error: levels are numbers
    { label: 'a level given as string', options: { level: { gzip: '6' } }, error: /got "6"/ },
    // @ts-expect-error: level is an object
    { label: 'levels that are no object', options: { level: 6 }, error: /level must be/ },
    // @ts-expect-error: threshold is a number
    { label: 'a threshold given as string', options: { threshold: '1kb' }, error: /got "1kb"/ },
  ];

  it.each(untyped)('should reject $label', ({ options, error }) => {
    expect(() => resolveOptions(options)).toThrow(error);
  });

  it('should throw RangeError for values out of range and TypeError for wrong types', () => {
    expect(() => resolveOptions({ threshold: -1 })).toThrow(RangeError);
    expect(() => resolveOptions({ level: { gzip: 1.5 } })).toThrow(RangeError);
    expect(() => resolveOptions({ encodings: [] })).toThrow(RangeError);
    expect(() => resolveOptions({ filter: 'yes' })).toThrow(TypeError);
    // @ts-expect-error: threshold is a number
    expect(() => resolveOptions({ threshold: '1kb' })).toThrow(TypeError);
    // @ts-expect-error: levels are numbers
    expect(() => resolveOptions({ level: { gzip: '6' } })).toThrow(TypeError);
  });

  it('should cite RFC 9659 only for zstd levels above 19', () => {
    expect(() => resolveOptions({ level: { zstd: 22 } })).toThrow(/RFC 9659/);
    expect(() => resolveOptions({ level: { zstd: 1.5 } })).toThrow(/got 1\.5$/);
  });
});
