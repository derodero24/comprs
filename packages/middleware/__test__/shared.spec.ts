import { describe, expect, it } from 'vitest';

import {
  appendVary,
  canCompressBody,
  hasNoTransform,
  headerValue,
  isCandidate,
  isCompressibleType,
  meetsThreshold,
  weakenEtag,
} from '../src/shared.js';

describe('headerValue', () => {
  it('should pass strings and undefined through', () => {
    expect(headerValue('text/plain')).toBe('text/plain');
    expect(headerValue(undefined)).toBeUndefined();
  });

  it('should stringify numbers', () => {
    expect(headerValue(2048)).toBe('2048');
  });

  it('should join list values', () => {
    expect(headerValue(['Origin', 'Cookie'])).toBe('Origin, Cookie');
  });
});

describe('hasNoTransform', () => {
  it('should find the directive among others, in any case', () => {
    expect(hasNoTransform('public, No-Transform, max-age=60')).toBe(true);
    expect(hasNoTransform(headerValue(['public', 'no-transform']))).toBe(true);
  });

  it('should match whole directives only', () => {
    expect(hasNoTransform('public, max-age=60')).toBe(false);
    expect(hasNoTransform('private="no-transform-list"')).toBe(false);
    expect(hasNoTransform(undefined)).toBe(false);
  });
});

describe('isCompressibleType', () => {
  it('should exclude Server-Sent Events from the text types', () => {
    expect(isCompressibleType('text/plain; charset=utf-8')).toBe(true);
    expect(isCompressibleType('text/event-stream')).toBe(false);
    expect(isCompressibleType('Text/Event-Stream; charset=utf-8')).toBe(false);
  });
});

describe('isCandidate', () => {
  const headers =
    (fields: Record<string, string>) =>
    (name: string): string | undefined =>
      fields[name];
  const pass = () => true;

  it('should accept a compressible response that the filter lets through', () => {
    expect(isCandidate(headers({ 'content-type': 'text/html' }), pass)).toBe(true);
  });

  it('should reject a response that is encoded, no-transform, filtered or of another type', () => {
    const html = { 'content-type': 'text/html' };
    expect(isCandidate(headers({ ...html, 'content-encoding': 'br' }), pass)).toBe(false);
    expect(isCandidate(headers({ ...html, 'cache-control': 'no-transform' }), pass)).toBe(false);
    expect(isCandidate(headers(html), () => false)).toBe(false);
    expect(isCandidate(headers({ 'content-type': 'image/png' }), pass)).toBe(false);
    expect(isCandidate(headers({}), pass)).toBe(false);
  });
});

describe('canCompressBody', () => {
  it('should allow statuses with content', () => {
    expect(canCompressBody(200, false)).toBe(true);
    expect(canCompressBody(404, false)).toBe(true);
  });

  it('should rule out statuses without content and ranges', () => {
    for (const status of [101, 204, 206, 304]) expect(canCompressBody(status, false)).toBe(false);
    expect(canCompressBody(200, true)).toBe(false);
    expect(canCompressBody(416, true)).toBe(false);
  });
});

describe('meetsThreshold', () => {
  it('should compare the length with the threshold', () => {
    expect(meetsThreshold(1024, 1024)).toBe(true);
    expect(meetsThreshold(1023, 1024)).toBe(false);
  });

  it('should rule out empty and unknown lengths, whatever the threshold', () => {
    expect(meetsThreshold(0, 0)).toBe(false);
    expect(meetsThreshold(Number.NaN, 0)).toBe(false);
  });
});

describe('weakenEtag', () => {
  it('should mark a strong entity tag as weak', () => {
    expect(weakenEtag('"abc"')).toBe('W/"abc"');
  });

  it('should keep a weak entity tag', () => {
    expect(weakenEtag('W/"abc"')).toBe('W/"abc"');
  });
});

describe('appendVary', () => {
  it('should add Accept-Encoding to an empty or missing value', () => {
    expect(appendVary(undefined)).toBe('Accept-Encoding');
    expect(appendVary('')).toBe('Accept-Encoding');
  });

  it('should append Accept-Encoding to other field names', () => {
    expect(appendVary('Origin, Cookie')).toBe('Origin, Cookie, Accept-Encoding');
  });

  it('should keep a value that lists Accept-Encoding in any case', () => {
    expect(appendVary('Origin, accept-encoding')).toBe('Origin, accept-encoding');
  });

  it('should match whole field names only', () => {
    expect(appendVary('X-Accept-Encoding-Hint')).toBe('X-Accept-Encoding-Hint, Accept-Encoding');
  });

  it('should keep a value that lists *', () => {
    expect(appendVary('*')).toBe('*');
    expect(appendVary('Origin, *')).toBe('Origin, *');
  });
});
