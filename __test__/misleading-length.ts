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

/** How far into its buffer the bytes of a view of {@link MISLEADING_VIEWS} start. */
const PAD = 32;

/** A view over `bytes`, which its buffer holds after {@link PAD} bytes of 0xA5. */
function padded<View>(
  bytes: Uint8Array,
  create: (buffer: ArrayBuffer, offset: number, length: number) => View,
): View {
  const buffer = new ArrayBuffer(PAD + bytes.length + PAD);
  const all = new Uint8Array(buffer);
  all.fill(0xa5);
  all.set(bytes, PAD);
  return create(buffer, PAD, bytes.length);
}

/**
 * A Uint8Array of `bytes`, of a subclass whose `byteLength` is `claim` of the
 * number of bytes that it holds.
 */
function subclassClaimingByteLength(
  bytes: Uint8Array,
  claim: (byteLength: number) => number,
): Uint8Array {
  const held = bytes.length;
  class Claiming extends Uint8Array {}
  Object.defineProperty(Claiming.prototype, 'byteLength', { get: () => claim(held) });
  return new Claiming(bytes);
}

/**
 * Kinds of views whose `byteLength`, `byteOffset` or `buffer` property
 * disagrees with the bytes that they hold (#711), each with the function
 * that makes such a view of `bytes`. The native addon reads their bytes, as
 * it reads those of any view.
 */
export const MISLEADING_VIEWS: readonly [
  kind: string,
  as: (bytes: Uint8Array) => ArrayBufferView,
][] = [
  [
    'a Uint8Array whose subclass claims a longer byteLength',
    (bytes) => subclassClaimingByteLength(bytes, (byteLength) => byteLength + EXTRA),
  ],
  [
    'a Uint8Array whose subclass claims a shorter byteLength',
    (bytes) => subclassClaimingByteLength(bytes, (byteLength) => Math.min(byteLength, 1)),
  ],
  [
    'a Uint8Array with an own, longer byteLength',
    (bytes) =>
      Object.defineProperty(Uint8Array.from(bytes), 'byteLength', {
        value: bytes.length + PAD,
      }),
  ],
  [
    'a Uint8Array with an own byteOffset of 0',
    (bytes) =>
      Object.defineProperty(
        padded(bytes, (buffer, offset, length) => new Uint8Array(buffer, offset, length)),
        'byteOffset',
        { value: 0 },
      ),
  ],
  [
    'a Uint8Array with an own buffer of other bytes',
    (bytes) =>
      Object.defineProperty(Uint8Array.from(bytes), 'buffer', {
        value: new Uint8Array(bytes.length).fill(0xa5).buffer,
      }),
  ],
  [
    'a DataView with an own byteOffset of 0',
    (bytes) =>
      Object.defineProperty(
        padded(bytes, (buffer, offset, length) => new DataView(buffer, offset, length)),
        'byteOffset',
        { value: 0 },
      ),
  ],
  [
    'a DataView with an own, longer byteLength',
    (bytes) =>
      Object.defineProperty(
        padded(bytes, (buffer, offset, length) => new DataView(buffer, offset, length)),
        'byteLength',
        { value: bytes.length + PAD },
      ),
  ],
];
