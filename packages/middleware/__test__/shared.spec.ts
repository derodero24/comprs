import { describe, expect, it } from 'vitest';

import { hasNoTransform, headerValue } from '../src/shared.js';

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
