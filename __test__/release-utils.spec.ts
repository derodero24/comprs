import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  packedFileProblems(name: string, packed: string[], required: string[]): string[];
  platformNoticeProblems(manifest: Manifest, notices: string[]): string[];
  prepublishProblems(packageJson: Record<string, unknown>): string[];
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
let packedFileProblems: ReleaseUtils['packedFileProblems'];
let platformNoticeProblems: ReleaseUtils['platformNoticeProblems'];
let prepublishProblems: ReleaseUtils['prepublishProblems'];
let browserEntryProblems: ReleaseUtils['browserEntryProblems'];

beforeAll(async () => {
  ({
    repositoryUrlProblems,
    packedFileProblems,
    platformNoticeProblems,
    prepublishProblems,
    browserEntryProblems,
  } = (await import(RELEASE_UTILS)) as ReleaseUtils);
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

/** The license files that check-release.mjs requires of each package. */
const LICENSE_FILES = ['LICENSE', 'THIRD_PARTY_LICENSES'];

describe('packedFileProblems', () => {
  it('reports each required file that the tarball lacks, once', () => {
    // npm packs LICENSE whatever `files` says, but not THIRD_PARTY_LICENSES.
    const packed = ['LICENSE', 'comprs.freebsd-x64.node', 'package.json'];
    const required = [
      'package.json',
      'comprs.freebsd-x64.node',
      ...LICENSE_FILES,
      './comprs.freebsd-x64.node',
      './THIRD_PARTY_LICENSES',
    ];
    expect(packedFileProblems('@scope/pkg-freebsd-x64', packed, required)).toEqual([
      '@scope/pkg-freebsd-x64 would be published without THIRD_PARTY_LICENSES',
    ]);
  });

  it('accepts a tarball that holds every required file', () => {
    const packed = ['LICENSE', 'THIRD_PARTY_LICENSES', 'index.js', 'package.json'];
    expect(
      packedFileProblems('The root package', packed, [...LICENSE_FILES, './index.js']),
    ).toEqual([]);
  });
});

describe('platformNoticeProblems', () => {
  it('reports the license files that a package.json from napi create-npm-dirs leaves out', () => {
    const created = {
      path: 'npm/freebsd-x64/package.json',
      json: { name: '@scope/pkg-freebsd-x64', files: ['comprs.freebsd-x64.node'] },
    };
    expect(platformNoticeProblems(created, LICENSE_FILES)).toEqual(
      LICENSE_FILES.map(
        (file) =>
          `npm/freebsd-x64/package.json does not list ${file} in "files"; add it there ` +
          '(napi create-npm-dirs writes "files" with the binary alone for a new target)',
      ),
    );
  });

  it('accepts a files field that lists them, also as ./ paths', () => {
    const json = { files: ['comprs.freebsd-x64.node', './LICENSE', 'THIRD_PARTY_LICENSES'] };
    expect(platformNoticeProblems({ path: 'package.json', json }, LICENSE_FILES)).toEqual([]);
  });

  it('accepts a package.json without files, which npm packs whole', () => {
    expect(platformNoticeProblems({ path: 'package.json', json: {} }, LICENSE_FILES)).toEqual([]);
  });

  it('accepts every platform package of the repository', () => {
    const dirs = readdirSync(resolve(__dirname, '../npm'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `npm/${entry.name}/package.json`);
    expect(dirs.length).toBeGreaterThan(0);
    for (const path of dirs) {
      expect(platformNoticeProblems({ path, json: readManifest(path) }, LICENSE_FILES)).toEqual([]);
    }
  });
});

describe('prepublishProblems', () => {
  function scripts(prepublishOnly: unknown): Record<string, unknown> {
    return { scripts: prepublishOnly === undefined ? {} : { prepublishOnly } };
  }

  it('accepts napi prepublish with --no-gh-release, as the root package.json has it', () => {
    expect(prepublishProblems(scripts('napi prepublish -t npm --no-gh-release'))).toEqual([]);
    expect(prepublishProblems(readManifest('package.json'))).toEqual([]);
  });

  it('reports napi prepublish without --no-gh-release, which creates the GitHub release', () => {
    expect(prepublishProblems(scripts('napi prepublish -t npm'))).toEqual([
      'The prepublishOnly script of package.json must pass --no-gh-release to napi prepublish: ' +
        'the GitHub Release job of release.yml creates the GitHub release, on the published ' +
        'commit and with the license notices next to the binaries',
    ]);
  });

  it.each([
    ['no prepublishOnly script', undefined, 'no prepublishOnly script'],
    ['another command', 'npm run build', 'the prepublishOnly script npm run build'],
    ['a script that is not a string', ['napi', 'prepublish'], 'no prepublishOnly script'],
  ])('reports %s', (_, script, found) => {
    expect(prepublishProblems(scripts(script))).toEqual([
      'package.json must run napi prepublish in its prepublishOnly script, which publishes the ' +
        `platform packages, but has ${found}`,
    ]);
  });

  it('reports a package.json without scripts', () => {
    expect(prepublishProblems({})).toEqual([
      'package.json must run napi prepublish in its prepublishOnly script, which publishes the ' +
        'platform packages, but has no prepublishOnly script',
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
const BROWSER_MODULES = [
  'browser/index.js',
  'browser/streams.js',
  'browser/wasm.js',
  'browser/next/browser.js',
  'browser/next/wasm.js',
  'browser/next/api.js',
  'browser/next/abort.js',
  'browser/next/backend.js',
];

/** The browser entry points of the package, which the tests check. */
const BROWSER_ENTRIES = ['browser/index.js', 'browser/streams.js', 'browser/next/browser.js'];

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
    return browserEntryProblems(dir, packed, BROWSER_ENTRIES, () => {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('browserEntryProblems', () => {
  it('accepts the browser entry points of the package', () => {
    expect(browserProblems({})).toEqual([]);
  });

  it.each([
    ['package.json', './browser/index.js', 'browser/index.js'],
    ['browser/package.json', './index.js', 'browser/index.js'],
    ['package.json', './browser/next/browser.js', 'browser/next/browser.js'],
    ['browser/package.json', './next/browser.js', 'browser/next/browser.js'],
  ] as const)(
    'reports an entry point that %s marks side-effect free (%s)',
    (manifest, pattern, entry) => {
      expect(browserProblems({ [manifest]: sideEffectsWithout(manifest, pattern) })).toEqual([
        `${manifest} marks the browser entry ${entry} as side-effect free, so bundlers may drop the initialisation of the WebAssembly module`,
      ]);
    },
  );

  // browser/index.js imports browser/wasm.js, which initialises the
  // WebAssembly module, for its side effects alone, as browser/next/browser.js
  // imports browser/next/wasm.js, which sets the backend of ./next: a bundler
  // that takes such a module for side-effect free drops the import, whatever
  // it keeps of the entry.
  it.each([
    ['package.json', './browser/wasm.js', 'browser/wasm.js', 'browser/index.js'],
    ['browser/package.json', './wasm.js', 'browser/wasm.js', 'browser/index.js'],
    ['package.json', './browser/next/wasm.js', 'browser/next/wasm.js', 'browser/next/browser.js'],
    ['browser/package.json', './next/wasm.js', 'browser/next/wasm.js', 'browser/next/browser.js'],
  ] as const)(
    'reports a module imported for its side effects only that %s marks side-effect free (%s)',
    (manifest, pattern, module, importer) => {
      expect(browserProblems({ [manifest]: sideEffectsWithout(manifest, pattern) })).toEqual([
        `${manifest} marks ${module}, which ${importer} imports for its side effects only, as side-effect free, so bundlers may drop that import`,
      ]);
    },
  );
});
