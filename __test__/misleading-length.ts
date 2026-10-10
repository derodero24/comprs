/** How many bytes more than it holds an array of {@link MISLEADING_LENGTHS} claims. */
const EXTRA = 4096;

/**
 * A Uint8Array of `bytes`, of a subclass whose `length` is `claim` of the
 * number of bytes that it holds.
 */
function subclassClaiming(bytes: Uint8Array, claim: (byteLength: number) => number): Uint8Array {
  class Claiming extends Uint8Array {}
  Object.defineProperty(Claiming.prototype, 'length', {
    get(this: Uint8Array): number {
      return claim(this.byteLength);
    },
  });
  return new Claiming(bytes);
}

/** A Uint8Array of `bytes` with an own `length` of `length`. */
function ownLength(bytes: Uint8Array, length: number): Uint8Array {
  return Object.defineProperty(Uint8Array.from(bytes), 'length', { value: length });
}

/**
 * Kinds of Uint8Arrays whose `length` property disagrees with the bytes that
 * they hold (#697), each with the function that makes such an array of
 * `bytes`. The native addon reads their bytes, as it reads those of any
 * typed array. The shorter kinds claim 1 byte, fewer than `bytes` holds if
 * it holds 2 or more: an array of 1 byte, such as the last chunk of a
 * stream, claims what it holds.
 */
export const MISLEADING_LENGTHS: readonly [kind: string, as: (bytes: Uint8Array) => Uint8Array][] =
  [
    [
      'a Uint8Array whose subclass claims a longer length',
      (bytes) => subclassClaiming(bytes, (byteLength) => byteLength + EXTRA),
    ],
    [
      'a Uint8Array whose subclass claims a shorter length',
      (bytes) => subclassClaiming(bytes, () => 1),
    ],
    ['a Uint8Array with an own, longer length', (bytes) => ownLength(bytes, bytes.length + EXTRA)],
    ['a Uint8Array with an own, shorter length', (bytes) => ownLength(bytes, 1)],
  ];
