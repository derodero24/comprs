import assert from 'node:assert';
import { version } from '../index.mjs';

assert.strictEqual(typeof version, 'function', 'version should be a function');
assert.strictEqual(version(), '0.1.0', 'version should return 0.1.0');

console.log('ESM import smoke test passed');
