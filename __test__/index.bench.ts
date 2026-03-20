import { bench, describe } from 'vitest';
import { version } from '../index.js';

describe('zflate', () => {
  bench('version()', () => {
    version();
  });
});
