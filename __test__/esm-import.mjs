import assert from 'node:assert';
import { version, zstdCompress, zstdDecompress } from '../index.mjs';

assert.strictEqual(typeof version, 'function', 'version should be a function');
assert.strictEqual(typeof zstdCompress, 'function', 'zstdCompress should be a function');
assert.strictEqual(typeof zstdDecompress, 'function', 'zstdDecompress should be a function');

// Round-trip test
const input = Buffer.from('ESM smoke test');
const compressed = zstdCompress(input);
const decompressed = zstdDecompress(compressed);
assert.deepStrictEqual(decompressed, input, 'round-trip should produce identical output');

console.log('ESM import smoke test passed');
