import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

interface Manifest {
  path: string;
  json: Record<string, unknown>;
}

interface ReleaseUtils {
  repositoryUrlProblems(manifests: Manifest[]): string[];
  browserEntryProblems(
    packageDir: string,
    packed: string[],
    entries: string[],
    log?: (line: string) => void,
  ): string[];
}

// release-utils.mjs has no declaration file, so a literal specifier would not
// type-check; the module is loaded through its URL and typed here instead.
const RELEASE_UTILS = pathToFileURL(resolve(__dirname, '../scripts/release-utils.mjs')).href;

const REPOSITORY = 'https://github.com/derodero24/comprs';

let repositoryUrlProblems: ReleaseUtils['repositoryUrlProblems'];
let browserEntryProblems: ReleaseUtils['browserEntryProblems'];

beforeAll(async () => {
  ({ repositoryUrlProblems, browserEntryProblems } = (await import(RELEASE_UTILS)) as ReleaseUtils);
});

function manifest(path: string, repository: unknown): Manifest {
  return { path, json: repository === undefined ? {} : { repository } };
}

describe('repositoryUrlProblems', () => {
  it('accepts the object and string forms with or without git+, .git and a trailing slash', () => {
    expect(
      repositoryUrlProblems([
        manifest('package.json', { type: 'git', url: `git+${REPOSITORY}.git` }),
        manifest('npm/linux-x64-gnu/package.json', `${REPOSITORY}.git`),
        manifest('npm/darwin-arm64/package.json', { url: `${REPOSITORY}/` }),
        manifest('packages/middleware/package.json', {
          url: `git+${REPOSITORY}.git`,
          directory: 'packages/middleware',
        }),
      ]),
    ).toEqual([]);
  });

  it('accepts a root package alone, and no packages at all', () => {
    expect(repositoryUrlProblems([manifest('package.json', REPOSITORY)])).toEqual([]);
    expect(repositoryUrlProblems([])).toEqual([]);
  });

  it('reports a package without a repository URL', () => {
    expect(
      repositoryUrlProblems([
        manifest('package.json', REPOSITORY),
        manifest('npm/win32-x64-msvc/package.json', undefined),
        manifest('npm/linux-arm64-musl/package.json', { type: 'git' }),
      ]),
    ).toEqual([
      `npm/win32-x64-msvc/package.json must name the repository ${REPOSITORY}, as package.json does, but has no repository URL`,
      `npm/linux-arm64-musl/package.json must name the repository ${REPOSITORY}, as package.json does, but has no repository URL`,
    ]);
  });

  it('reports a package that names another repository', () => {
    expect(
      repositoryUrlProblems([
        manifest('package.json', REPOSITORY),
        manifest(
          'packages/middleware/package.json',
          'https://github.com/derodero24/comprs-middleware',
        ),
      ]),
    ).toEqual([
      `packages/middleware/package.json must name the repository ${REPOSITORY}, as package.json does, but has the repository URL https://github.com/derodero24/comprs-middleware`,
    ]);
  });

  it.each([
    ['an ssh URL', 'git@github.com:derodero24/comprs.git', 'git@github.com:derodero24/comprs'],
    ['the shorthand', 'derodero24/comprs', 'derodero24/comprs'],
    [
      'another host',
      'https://gitlab.com/derodero24/comprs',
      'https://gitlab.com/derodero24/comprs',
    ],
    ['a URL inside the repository', `${REPOSITORY}/tree/develop`, `${REPOSITORY}/tree/develop`],
    ['a query', `${REPOSITORY}?tab=readme`, `${REPOSITORY}?tab=readme`],
    ['an empty query', `${REPOSITORY}?`, `${REPOSITORY}?`],
    ['a fragment', `${REPOSITORY}#readme`, `${REPOSITORY}#readme`],
    [
      'credentials',
      'https://user@github.com/derodero24/comprs',
      'https://user@github.com/derodero24/comprs',
    ],
    [
      'a port',
      'https://github.com:8443/derodero24/comprs',
      'https://github.com:8443/derodero24/comprs',
    ],
    ['plain http', 'http://github.com/derodero24/comprs', 'http://github.com/derodero24/comprs'],
    [
      'a percent-encoded name',
      'https://github.com/derodero24/com%20prs',
      'https://github.com/derodero24/com%20prs',
    ],
  ])(
    'reports a root package that names %s instead of a GitHub repository',
    (_, url, normalized) => {
      expect(
        repositoryUrlProblems([
          manifest('package.json', url),
          manifest('npm/linux-x64-gnu/package.json', url),
        ]),
      ).toEqual([
        `package.json must name a GitHub repository, https://github.com/<owner>/<repository>, but has the repository URL ${normalized}`,
      ]);
    },
  );

  it('reports a root package without a repository URL', () => {
    expect(repositoryUrlProblems([manifest('package.json', undefined)])).toEqual([
      'package.json must name a GitHub repository, https://github.com/<owner>/<repository>, but has no repository URL',
    ]);
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The JSON object in the file at `path`, relative to the repository. */
function readManifest(path: string): Record<string, unknown> {
  const json: unknown = JSON.parse(readFileSync(resolve(__dirname, '..', path), 'utf8'));
  if (!isRecord(json)) throw new Error(`${path} does not hold a JSON object`);
  return json;
}

/** The `sideEffects` of the package.json at `path`, without `pattern`. */
function sideEffectsWithout(path: string, pattern: string): unknown[] {
  const sideEffects = readManifest(path)['sideEffects'];
  if (!Array.isArray(sideEffects)) throw new Error(`${path} has no sideEffects array`);
  const others: unknown[] = sideEffects.filter((item) => item !== pattern);
  if (others.length === sideEffects.length) throw new Error(`${path} does not list ${pattern}`);
  return others;
}

/** The browser modules of the package, which the tests copy. */
const BROWSER_MODULES = ['browser/index.js', 'browser/streams.js', 'browser/wasm.js'];

/** The `sideEffects` fields of the manifests of a package. */
interface SideEffects {
  'package.json'?: unknown[];
  'browser/package.json'?: unknown[];
}

/**
 * The problems that browserEntryProblems() finds in the browser entry points
 * of a package made of the browser modules of this one and its manifests,
 * with their `sideEffects` replaced by those of `sideEffects`. The
 * wasm-bindgen glue and the WebAssembly module, which the tests do not
 * build, are stubs: the check parses the modules without running them.
 */
function browserProblems(sideEffects: SideEffects): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'comprs-browser-entry-'));
  try {
    const files: Record<string, string> = {
      'browser/comprs-wasm.js': 'export default async function init() {}\n',
      'browser/comprs-wasm_bg.wasm': '',
    };
    for (const manifest of ['package.json', 'browser/package.json'] as const) {
      const json = readManifest(manifest);
      files[manifest] = JSON.stringify({
        ...json,
        sideEffects: sideEffects[manifest] ?? json['sideEffects'],
      });
    }
    for (const module of BROWSER_MODULES) {
      files[module] = readFileSync(resolve(__dirname, '..', module), 'utf8');
    }
    for (const [path, contents] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), contents);
    }
    const packed = Object.keys(files).sort();
    return browserEntryProblems(dir, packed, ['browser/index.js', 'browser/streams.js'], () => {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('browserEntryProblems', () => {
  it('accepts the browser entry points of the package', () => {
    expect(browserProblems({})).toEqual([]);
  });

  it.each([
    ['package.json', './browser/index.js'],
    ['browser/package.json', './index.js'],
  ] as const)('reports an entry point that %s marks side-effect free', (manifest, pattern) => {
    expect(browserProblems({ [manifest]: sideEffectsWithout(manifest, pattern) })).toEqual([
      `${manifest} marks the browser entry browser/index.js as side-effect free, so bundlers may drop the initialisation of the WebAssembly module`,
    ]);
  });

  // browser/index.js imports browser/wasm.js, which initialises the
  // WebAssembly module, for its side effects alone: a bundler that takes it
  // for side-effect free drops the import, whatever it keeps of the entry.
  it.each([
    ['package.json', './browser/wasm.js'],
    ['browser/package.json', './wasm.js'],
  ] as const)(
    'reports a module imported for its side effects only that %s marks side-effect free',
    (manifest, pattern) => {
      expect(browserProblems({ [manifest]: sideEffectsWithout(manifest, pattern) })).toEqual([
        `${manifest} marks browser/wasm.js, which browser/index.js imports for its side effects only, as side-effect free, so bundlers may drop that import`,
      ]);
    },
  );
});
