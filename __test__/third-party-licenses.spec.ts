import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

interface CrateId {
  name: string;
  version: string;
}

interface CargoPackage extends CrateId {
  license: string | null;
  licenseFile: string | null;
  repository: string | null;
  source: string | null;
  manifestPath: string;
}

interface LicenseText {
  file: string;
  text: string;
}

interface NoticeCrate extends CrateId {
  license: string | null;
  repository: string | null;
  texts: LicenseText[];
}

interface ThirdPartyLicenses {
  parseCargoTree(output: string): CrateId[];
  parseCargoMetadata(output: string): CargoPackage[];
  collectLicenses(crates: CrateId[], packages: CargoPackage[]): NoticeCrate[];
  renderNotice(notice: { title: string; crates: NoticeCrate[] }): string;
  indexedCrates(notice: string): CrateId[];
}

// third-party-licenses.mjs has no declaration file, so a literal specifier
// would not type-check; the module is loaded through its URL and typed here
// instead.
const THIRD_PARTY_LICENSES = pathToFileURL(
  resolve(__dirname, '../scripts/third-party-licenses.mjs'),
).href;

const REGISTRY = 'registry+https://github.com/rust-lang/crates.io-index';

let licenses: ThirdPartyLicenses;

beforeAll(async () => {
  licenses = (await import(THIRD_PARTY_LICENSES)) as ThirdPartyLicenses;
});

describe('parseCargoTree', () => {
  it('reads the name and version of each line, without the source and (*)', () => {
    const output = [
      'comprs v2.0.2 (/home/user/comprs/crates/core)',
      'comprs-core v2.0.2 (/home/user/comprs/crates/core-lib)',
      'brotli v9.0.0',
      'alloc-stdlib v0.3.0',
      'alloc-stdlib v0.3.0 (*)',
      'zstd-sys v2.1.0+zstd.1.5.7',
      'some-git-crate v0.1.0 (https://github.com/owner/repo?rev=abc#abcdef01)',
      'some-registry-crate v1.0.0 (registry `my-registry`)',
      '',
    ].join('\n');
    expect(licenses.parseCargoTree(output)).toEqual([
      { name: 'comprs', version: '2.0.2' },
      { name: 'comprs-core', version: '2.0.2' },
      { name: 'brotli', version: '9.0.0' },
      { name: 'alloc-stdlib', version: '0.3.0' },
      { name: 'zstd-sys', version: '2.1.0+zstd.1.5.7' },
      { name: 'some-git-crate', version: '0.1.0' },
      { name: 'some-registry-crate', version: '1.0.0' },
    ]);
  });

  it('lists each version of a crate once, and two versions apart', () => {
    const output = 'syn v2.0.0\nsyn v1.0.109\nsyn v2.0.0 (*)\nsyn v1.0.109\n';
    expect(licenses.parseCargoTree(output)).toEqual([
      { name: 'syn', version: '2.0.0' },
      { name: 'syn', version: '1.0.109' },
    ]);
  });

  it('fails on a line it cannot read, rather than leave a crate out', () => {
    expect(() => licenses.parseCargoTree('brotli v9.0.0\n[build-dependencies]\n')).toThrow(
      'Unexpected line in the cargo tree output: [build-dependencies]',
    );
  });
});

const MIT = 'MIT License\n\nCopyright (c) Someone\n\nPermission is hereby granted.';
const APACHE = 'Apache License\nVersion 2.0, January 2004';

function crate(
  name: string,
  version: string,
  texts: LicenseText[],
  license: string | null = 'MIT',
): NoticeCrate {
  return { name, version, license, repository: `https://github.com/owner/${name}`, texts };
}

const CRATES = [
  crate('zeta', '1.0.0', [{ file: 'LICENSE', text: MIT }]),
  crate(
    'alpha',
    '0.2.0',
    [
      { file: 'LICENSE-MIT', text: MIT.replaceAll('\n', '\r\n') },
      { file: 'LICENSE-APACHE', text: APACHE },
    ],
    'MIT OR Apache-2.0',
  ),
  crate('alpha', '0.10.0', [{ file: 'LICENSE-APACHE', text: `${APACHE}\n\n` }], null),
  crate('middle', '3.1.4', [{ file: 'COPYING', text: 'Some other license' }], 'Zlib'),
  crate('beta', '1.0.0', [{ file: 'LICENSE-APACHE', text: APACHE }], 'Apache-2.0'),
];

/** The lines of a notice that start with `Used by:`. */
function usedBy(notice: string): string[] {
  return notice.split('\n').filter((line) => line.startsWith('Used by: '));
}

describe('renderNotice', () => {
  it('renders the same text for the crates and texts in any order', () => {
    const notice = licenses.renderNotice({ title: 'pkg (triple)', crates: CRATES });
    const shuffled = [...CRATES].reverse().map((item) => ({
      ...item,
      texts: [...item.texts].reverse(),
    }));
    const rotated = [...CRATES.slice(2), ...CRATES.slice(0, 2)];
    expect(licenses.renderNotice({ title: 'pkg (triple)', crates: shuffled })).toBe(notice);
    expect(licenses.renderNotice({ title: 'pkg (triple)', crates: rotated })).toBe(notice);
  });

  it('starts with the title and ends with one line feed, without carriage returns', () => {
    const notice = licenses.renderNotice({
      title: '@scope/pkg (x86_64-unknown-linux-gnu)',
      crates: CRATES,
    });
    expect(notice.split('\n')[0]).toBe(
      'Third-party licenses for @scope/pkg (x86_64-unknown-linux-gnu)',
    );
    expect(notice).toMatch(/[^\n]\n$/);
    expect(notice).not.toContain('\r');
    expect(notice).not.toMatch(/[ \t]$/m);
  });

  it('writes each text once, for every crate that uses it, also when line endings differ', () => {
    const notice = licenses.renderNotice({ title: 'pkg (triple)', crates: CRATES });
    expect(usedBy(notice)).toEqual([
      'Used by: alpha 0.10.0 (LICENSE-APACHE), alpha 0.2.0 (LICENSE-APACHE), beta 1.0.0 (LICENSE-APACHE)',
      'Used by: alpha 0.2.0 (LICENSE-MIT), zeta 1.0.0 (LICENSE)',
      'Used by: middle 3.1.4 (COPYING)',
    ]);
    expect(notice.split(MIT)).toHaveLength(2);
    expect(notice.split(APACHE)).toHaveLength(2);
    expect(notice).toContain('Some other license');
  });

  it('lists every crate in the index and in a Used by line', () => {
    const notice = licenses.renderNotice({ title: 'pkg (triple)', crates: CRATES });
    const expected = [
      { name: 'alpha', version: '0.10.0' },
      { name: 'alpha', version: '0.2.0' },
      { name: 'beta', version: '1.0.0' },
      { name: 'middle', version: '3.1.4' },
      { name: 'zeta', version: '1.0.0' },
    ];
    expect(licenses.indexedCrates(notice)).toEqual(expected);
    const users = usedBy(notice).join('\n');
    for (const { name, version } of expected) {
      expect(users).toContain(`${name} ${version} (`);
    }
    expect(notice).toMatch(
      /^ {2}alpha 0\.2\.0 +MIT OR Apache-2\.0 +https:\/\/github\.com\/owner\/alpha$/m,
    );
    expect(notice).toMatch(/^ {2}middle 3\.1\.4 +Zlib +https:\/\/github\.com\/owner\/middle$/m);
    expect(notice).toMatch(
      /^ {2}alpha 0\.10\.0 +\(license file\) +https:\/\/github\.com\/owner\/alpha$/m,
    );
  });
});

describe('collectLicenses', () => {
  let registry: string;

  beforeEach(() => {
    registry = mkdtempSync(join(tmpdir(), 'comprs-licenses-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(registry, { recursive: true, force: true });
  });

  /**
   * A crate in a fake registry: a directory with a Cargo.toml and the given
   * files, and its cargo metadata entry.
   */
  function registryCrate(
    name: string,
    version: string,
    files: Record<string, string>,
    fields: Partial<CargoPackage> = {},
  ): CargoPackage {
    const dir = join(registry, `${name}-${version}`);
    for (const [file, contents] of Object.entries({ 'Cargo.toml': '[package]\n', ...files })) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), contents);
    }
    return {
      name,
      version,
      license: 'MIT',
      licenseFile: null,
      repository: `https://github.com/owner/${name}`,
      source: REGISTRY,
      manifestPath: join(dir, 'Cargo.toml'),
      ...fields,
    };
  }

  it('reads the license files of each crate, normalized, and nothing else', () => {
    const packages = [
      registryCrate('alpha', '1.0.0', {
        'LICENSE-MIT': 'MIT text  \r\n\r\n',
        'LICENSE-APACHE': '\uFEFFApache text',
        'COPYING.md': 'Copying text',
        'README.md': 'Not a license',
        'src/LICENSE': 'Not at the root',
        'license.d/notice': 'A directory is not a license file',
      }),
      registryCrate(
        'beta',
        '2.0.0',
        { 'docs/terms.txt': 'Declared text' },
        {
          licenseFile: 'docs/terms.txt',
        },
      ),
    ];
    expect(
      licenses.collectLicenses(
        [
          { name: 'alpha', version: '1.0.0' },
          { name: 'beta', version: '2.0.0' },
        ],
        packages,
      ),
    ).toEqual([
      {
        name: 'alpha',
        version: '1.0.0',
        license: 'MIT',
        repository: 'https://github.com/owner/alpha',
        texts: [
          { file: 'COPYING.md', text: 'Copying text' },
          { file: 'LICENSE-APACHE', text: 'Apache text' },
          { file: 'LICENSE-MIT', text: 'MIT text' },
        ],
      },
      {
        name: 'beta',
        version: '2.0.0',
        license: 'MIT',
        repository: 'https://github.com/owner/beta',
        texts: [{ file: 'docs/terms.txt', text: 'Declared text' }],
      },
    ]);
  });

  it('adds the license of the zstd C library that zstd-sys bundles, but not its GPL alternative', () => {
    const zstdSys = registryCrate('zstd-sys', '2.1.0+zstd.1.5.7', {
      LICENSE: 'zstd-sys bindings license',
      'zstd/LICENSE': 'BSD License\n\nFor Zstandard software',
      'zstd/COPYING': 'GNU GENERAL PUBLIC LICENSE',
    });
    const [found] = licenses.collectLicenses(
      [{ name: 'zstd-sys', version: '2.1.0+zstd.1.5.7' }],
      [zstdSys],
    );
    expect(found?.texts).toEqual([
      { file: 'LICENSE', text: 'zstd-sys bindings license' },
      { file: 'zstd/LICENSE', text: 'BSD License\n\nFor Zstandard software' },
    ]);
  });

  it('fails when the bundled zstd license is missing', () => {
    const zstdSys = registryCrate('zstd-sys', '2.1.0+zstd.1.5.7', {
      LICENSE: 'zstd-sys bindings license',
    });
    expect(() =>
      licenses.collectLicenses([{ name: 'zstd-sys', version: '2.1.0+zstd.1.5.7' }], [zstdSys]),
    ).toThrow('zstd-sys 2.1.0+zstd.1.5.7 has no zstd/LICENSE');
  });

  it('uses the committed copy of the upstream license for a crate that ships none', () => {
    const napi = registryCrate('napi', '3.14.0', { 'README.md': 'napi' });
    const [found] = licenses.collectLicenses([{ name: 'napi', version: '3.14.0' }], [napi]);
    expect(found?.texts).toHaveLength(1);
    expect(found?.texts[0]?.file).toMatch(
      /^https:\/\/github\.com\/napi-rs\/napi-rs\/blob\/[\da-f]{40}\/LICENSE$/,
    );
    expect(found?.texts[0]?.text).toContain('Copyright (c) 2020-present LongYinan');
  });

  it('leaves out a license-file outside the crate sources, for the override', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const napi = registryCrate(
      'napi',
      '2.0.0',
      { 'README.md': 'napi' },
      { licenseFile: '../LICENSE' },
    );
    const [found] = licenses.collectLicenses([{ name: 'napi', version: '2.0.0' }], [napi]);
    expect(found?.texts).toHaveLength(1);
    expect(found?.texts[0]?.text).toContain('Copyright (c) 2020-present LongYinan');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('napi 2.0.0 names the license file ../LICENSE, which is not in'),
    );
  });

  it('leaves out a missing license-file, for the license files that the crate ships', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const old = registryCrate(
      'old',
      '0.1.0',
      { 'LICENSE-MIT': 'MIT text' },
      { licenseFile: '../LICENSE' },
    );
    const [found] = licenses.collectLicenses([{ name: 'old', version: '0.1.0' }], [old]);
    expect(found?.texts).toEqual([{ file: 'LICENSE-MIT', text: 'MIT text' }]);
  });

  it('fails on a crate whose license-file is missing, without an override or other files', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const packages = [
      registryCrate('old', '0.1.0', { 'README.md': 'old' }, { licenseFile: '../LICENSE' }),
      registryCrate('bare', '0.2.0', { 'README.md': '' }),
    ];
    const crates = packages.map(({ name, version }) => ({ name, version }));
    expect(() => licenses.collectLicenses(crates, packages)).toThrow(
      /^No license text for old 0\.1\.0, bare 0\.2\.0: .*OVERRIDES/,
    );
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('prefers the license files that a crate ships over its override', () => {
    const napi = registryCrate('napi', '9.0.0', { LICENSE: 'Shipped at last' });
    const [found] = licenses.collectLicenses([{ name: 'napi', version: '9.0.0' }], [napi]);
    expect(found?.texts).toEqual([{ file: 'LICENSE', text: 'Shipped at last' }]);
  });

  it('names every crate without a license text in one error', () => {
    const packages = [
      registryCrate('licensed', '1.0.0', { LICENSE: 'MIT' }),
      registryCrate('first-bare', '0.1.0', { 'README.md': '' }),
      registryCrate('second-bare', '0.2.0', { LICENSE: ' \n\n' }),
    ];
    const crates = packages.map(({ name, version }) => ({ name, version }));
    expect(() => licenses.collectLicenses(crates, packages)).toThrow(
      /^No license text for first-bare 0\.1\.0, second-bare 0\.2\.0: .*scripts\/licenses\/.*OVERRIDES/,
    );
  });

  it('leaves out the crates of the workspace, which LICENSE covers', () => {
    const packages = [
      registryCrate('comprs-core', '2.0.2', {}, { source: null }),
      registryCrate('brotli', '9.0.0', { 'LICENSE.MIT': 'MIT' }),
    ];
    expect(
      licenses
        .collectLicenses(
          [
            { name: 'comprs-core', version: '2.0.2' },
            { name: 'brotli', version: '9.0.0' },
          ],
          packages,
        )
        .map(({ name }) => name),
    ).toEqual(['brotli']);
  });

  it('fails on a crate that cargo metadata does not list', () => {
    expect(() => licenses.collectLicenses([{ name: 'ghost', version: '1.0.0' }], [])).toThrow(
      'cargo metadata does not list ghost 1.0.0',
    );
  });
});

describe('parseCargoMetadata', () => {
  it('reads the fields of each package that the notice needs', () => {
    const output = JSON.stringify({
      packages: [
        {
          name: 'brotli',
          version: '9.0.0',
          license: 'BSD-3-Clause AND MIT',
          license_file: null,
          repository: 'https://github.com/dropbox/rust-brotli',
          source: REGISTRY,
          manifest_path: '/registry/brotli-9.0.0/Cargo.toml',
          description: 'ignored',
        },
        {
          name: 'comprs',
          version: '2.0.2',
          license: 'MIT',
          license_file: null,
          repository: null,
          source: null,
          manifest_path: '/repo/crates/core/Cargo.toml',
        },
      ],
      workspace_members: [],
    });
    expect(licenses.parseCargoMetadata(output)).toEqual([
      {
        name: 'brotli',
        version: '9.0.0',
        license: 'BSD-3-Clause AND MIT',
        licenseFile: null,
        repository: 'https://github.com/dropbox/rust-brotli',
        source: REGISTRY,
        manifestPath: '/registry/brotli-9.0.0/Cargo.toml',
      },
      {
        name: 'comprs',
        version: '2.0.2',
        license: 'MIT',
        licenseFile: null,
        repository: null,
        source: null,
        manifestPath: '/repo/crates/core/Cargo.toml',
      },
    ]);
  });

  it('fails on output without packages', () => {
    expect(() => licenses.parseCargoMetadata('{}')).toThrow('cargo metadata');
  });
});
