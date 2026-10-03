import { DEFAULT_ENCODINGS, DEFAULT_THRESHOLD } from './shared.js';
import type { ComprsOptions, Encoding, LevelOptions } from './types.js';

/** The options every adapter takes; the filter's signature differs per framework. */
export type SharedOptions = Omit<ComprsOptions, 'filter'> & { filter?: unknown };

/** Shared options, checked and with their defaults applied. */
export interface Settings {
  encodings: readonly Encoding[];
  threshold: number;
  level: LevelOptions | undefined;
}

/**
 * The levels each encoding accepts. zstd stops at 19: from level 20 on, a
 * frame of unknown size declares a window above the 8 MiB that RFC 9659,
 * section 3, allows for the `zstd` content coding.
 */
const LEVELS: Readonly<Record<Encoding, readonly [min: number, max: number]>> = {
  zstd: [-131072, 19],
  br: [0, 11],
  gzip: [0, 9],
  deflate: [0, 9],
};

const ENCODINGS = Object.keys(LEVELS);

function isEncoding(value: unknown): value is Encoding {
  return typeof value === 'string' && Object.hasOwn(LEVELS, value);
}

/** Render a rejected value for an error message. */
function show(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

function checkEncodings(encodings: unknown): readonly Encoding[] {
  if (encodings === undefined) return DEFAULT_ENCODINGS;
  if (!Array.isArray(encodings)) {
    throw new TypeError(`comprs: encodings must be an array, got ${show(encodings)}`);
  }
  if (encodings.length === 0) {
    throw new RangeError(`comprs: encodings must not be empty; use any of ${ENCODINGS.join(', ')}`);
  }
  const checked: Encoding[] = [];
  for (const encoding of encodings) {
    if (!isEncoding(encoding)) {
      throw new RangeError(
        `comprs: encodings contains ${show(encoding)}; expected one of ${ENCODINGS.join(', ')}`,
      );
    }
    checked.push(encoding);
  }
  return checked;
}

function checkThreshold(threshold: unknown): number {
  if (threshold === undefined) return DEFAULT_THRESHOLD;
  const message = `comprs: threshold must be a finite number of bytes, 0 or more, got ${show(threshold)}`;
  if (typeof threshold !== 'number') throw new TypeError(message);
  if (!Number.isFinite(threshold) || threshold < 0) throw new RangeError(message);
  return threshold;
}

function checkLevel(encoding: Encoding, level: unknown): number | undefined {
  if (level === undefined) return undefined;
  const [min, max] = LEVELS[encoding];
  const message = `comprs: level.${encoding} must be an integer from ${min} to ${max}, got ${show(level)}`;
  if (typeof level !== 'number') throw new TypeError(message);
  if (!Number.isInteger(level) || level < min || level > max) {
    const reason =
      encoding === 'zstd' && level > max
        ? '; levels above 19 exceed the 8 MiB window that RFC 9659 allows for HTTP'
        : '';
    throw new RangeError(`${message}${reason}`);
  }
  return level;
}

function checkLevels(levels: unknown): LevelOptions | undefined {
  if (levels === undefined) return undefined;
  if (typeof levels !== 'object' || levels === null || Array.isArray(levels)) {
    throw new TypeError(`comprs: level must be an object, got ${show(levels)}`);
  }
  const checked: LevelOptions = {};
  for (const [encoding, level] of Object.entries(levels)) {
    if (!isEncoding(encoding)) {
      throw new RangeError(
        `comprs: level.${encoding} is not an encoding; expected one of ${ENCODINGS.join(', ')}`,
      );
    }
    const value = checkLevel(encoding, level);
    if (value !== undefined) checked[encoding] = value;
  }
  return checked;
}

/** Check that an optional callback option, if given, is a function. */
export function checkCallback(name: string, callback: unknown): void {
  if (callback !== undefined && typeof callback !== 'function') {
    throw new TypeError(`comprs: ${name} must be a function, got ${show(callback)}`);
  }
}

/**
 * Check the options shared by every adapter and apply their defaults. Throws
 * a TypeError or RangeError that names the offending option, so that a
 * misconfiguration fails at setup instead of on every request.
 */
export function resolveOptions(options: SharedOptions): Settings {
  checkCallback('filter', options.filter);
  return {
    encodings: checkEncodings(options.encodings),
    threshold: checkThreshold(options.threshold),
    level: checkLevels(options.level),
  };
}
