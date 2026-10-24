import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import * as root from '../index.js';
import { compressSync, decompressSync } from '../next/index.js';

// The *WithCapacity, *WithDict and *WithDictWithCapacity functions of the
// package root, and their *Async forms, are deprecated in favor of options of
// the unified API (#577). Their declarations say so with a @deprecated tag
// that names the replacement, in the native and the browser declarations
// alike, and the README and the Classic API page of the website have a table
// of the replacements. These tests keep them in step, and run each
// replacement that the table shows.

/** The synchronous functions that are deprecated, with an *Async form each. */
const DEPRECATED = [
  'zstdDecompressWithCapacity',
  'zstdCompressWithDict',
  'zstdDecompressWithDict',
  'zstdDecompressWithDictWithCapacity',
  'gzipDecompressWithCapacity',
  'deflateDecompressWithCapacity',
  'brotliDecompressWithCapacity',
  'brotliCompressWithDict',
  'brotliDecompressWithDict',
  'brotliDecompressWithDictWithCapacity',
  'lz4DecompressWithCapacity',
] as const;

type Deprecated = (typeof DEPRECATED)[number];

const ROOT = resolve(__dirname, '..');

/** The file at `path`, with LF line endings, as a checkout on Windows may not have. */
function read(path: string): string {
  return readFileSync(resolve(ROOT, path), 'utf8').replaceAll('\r\n', '\n');
}

/**
 * The replacement that the @deprecated tag of each function declared in
 * `source` names: the code span that follows `@deprecated Use`.
 */
function deprecations(source: string): Map<string, string> {
  const found = new Map<string, string>();
  const declaration = /\/\*\*((?:(?!\*\/)[\s\S])*)\*\/\s*export declare function (\w+)\(/g;
  for (const [, comment = '', name = ''] of source.matchAll(declaration)) {
    const replacement = /@deprecated Use `([^`]+)`/.exec(comment)?.[1];
    if (replacement !== undefined) {
      found.set(name, replacement);
    }
  }
  return found;
}

/**
 * The rows of the table of replacements in the section of the Markdown file
 * at `path` under `heading`: deprecated call to replacement.
 */
function replacementTable(path: string, heading: string): Map<string, string> {
  const markdown = read(path);
  const start = markdown.indexOf(`${heading}\n`);
  if (start === -1) {
    throw new Error(`${path} has no section ${heading}`);
  }
  const section = markdown.slice(start, markdown.indexOf('\n## ', start + heading.length));
  const rows = new Map<string, string>();
  for (const [, call = '', replacement = ''] of section.matchAll(
    /^\| `(\w+\([^`]*\))` \| `([^`]+)` \|$/gm,
  )) {
    rows.set(call, replacement);
  }
  return rows;
}

/** The replacement of the *Async form of a function whose replacement is `sync`. */
function asyncReplacement(sync: string): string {
  return `await ${sync.replace(/^(compress|decompress)Sync\(/, '$1(')}`;
}

const native = deprecations(read('index.d.ts'));
const browser = deprecations(read('browser/index.d.ts'));
const table = replacementTable('README.md', '### From the deprecated functions');
const siteTable = replacementTable(
  'website/src/content/docs/reference/classic-api.md',
  '## Deprecated functions',
);

describe('deprecated functions', () => {
  const expected = DEPRECATED.flatMap((name) => [name, `${name}Async`]).sort();

  it('are those of #577 in the native declarations', () => {
    expect([...native.keys()].sort()).toEqual(expected);
  });

  it('are those of #577 in the browser declarations, with the same replacements', () => {
    expect(Object.fromEntries(browser)).toEqual(Object.fromEntries(native));
  });

  it('are replaced by the asynchronous function of the same options in their *Async form', () => {
    for (const name of DEPRECATED) {
      expect(native.get(`${name}Async`), name).toBe(asyncReplacement(native.get(name) ?? ''));
    }
  });

  it('are listed in the README with the replacements that their declarations name', () => {
    const listed = Object.fromEntries(
      [...table].map(([call, replacement]) => [call.slice(0, call.indexOf('(')), replacement]),
    );
    expect(listed).toEqual(Object.fromEntries(DEPRECATED.map((name) => [name, native.get(name)])));
  });

  it('are listed on the website with the replacements of the README', () => {
    expect(Object.fromEntries(siteTable)).toEqual(Object.fromEntries(table));
  });

  describe('give the result of their replacement in the README', () => {
    const text = new TextEncoder().encode(
      '{"id":1,"name":"comprs","tags":["zstd","brotli","gzip","lz4"]}\n'.repeat(200),
    );
    const dict = text.subarray(0, 512);
    const level = 5;
    const quality = 5;

    /** The data that each deprecated function takes, made with the classic API. */
    const inputs: Record<Deprecated, Uint8Array> = {
      zstdDecompressWithCapacity: root.zstdCompress(text),
      zstdCompressWithDict: text,
      zstdDecompressWithDict: root.zstdCompressWithDict(text, dict),
      zstdDecompressWithDictWithCapacity: root.zstdCompressWithDict(text, dict),
      gzipDecompressWithCapacity: root.gzipCompress(text),
      deflateDecompressWithCapacity: root.deflateCompress(text),
      brotliDecompressWithCapacity: root.brotliCompress(text),
      brotliCompressWithDict: text,
      brotliDecompressWithDict: root.brotliCompressWithDict(text, dict),
      brotliDecompressWithDictWithCapacity: root.brotliCompressWithDict(text, dict),
      lz4DecompressWithCapacity: root.lz4Compress(text),
    };

    /**
     * What `code`, a call of the table, returns or throws with `data` and
     * `capacity`: an optional argument (`level?`) is passed too.
     */
    function outcome(code: string, data: Uint8Array, capacity: number): unknown {
      const context = { root, compressSync, decompressSync, data, dict, capacity, level, quality };
      try {
        return { returned: new Uint8Array(runInNewContext(code, context) as Uint8Array) };
      } catch {
        return 'threw';
      }
    }

    for (const [call, replacement] of table) {
      it(call, () => {
        const name = call.slice(0, call.indexOf('(')) as Deprecated;
        // A capacity that fits the output, and one that does not.
        for (const capacity of [text.byteLength, text.byteLength - 1]) {
          expect(outcome(replacement, inputs[name], capacity), `capacity ${capacity}`).toEqual(
            outcome(`root.${call.replaceAll('?', '')}`, inputs[name], capacity),
          );
        }
      });
    }
  });
});
