import { Buffer } from 'node:buffer';
import { expect } from 'vitest';

// toEqual and toStrictEqual compare byte arrays element by element, then
// compare Object.entries() of both: about 4 seconds for two 1 MiB Buffers,
// and several times that on slow CI runners. Both matchers try the equality
// testers registered here first, so this one compares the bytes with
// Buffer.compare instead. It compares the bytes alone: other own properties
// of the arrays, which Vitest's comparison would check too, are ignored, and
// no test sets any. Byte arrays of different classes, such as a Buffer and a
// Uint8Array, go on to Vitest's own comparison, which tells them apart as
// before. A failed comparison prints Vitest's usual diff.
//
// vitest.config.mts and packages/middleware/vitest.config.mts load this file
// with setupFiles, and byte-array-equality.spec.ts tests it.
expect.addEqualityTesters([
  function byteArrayEquality(a: unknown, b: unknown): boolean | undefined {
    if (a instanceof Uint8Array && b instanceof Uint8Array && a.constructor === b.constructor) {
      return Buffer.compare(a, b) === 0;
    }
    return undefined;
  },
]);
