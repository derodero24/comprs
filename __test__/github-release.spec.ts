import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

interface ReleaseTarget {
  triple: string;
  abi: string;
  artifact: string;
  packageName: string;
  packageDir: string;
}

interface ReleaseAsset {
  name: string;
  source: string;
}

interface ReleaseNotes {
  section: string | undefined;
  changelogUrl: string;
  binaryName: string;
  packageName: string;
}

interface GitHubRelease {
  releaseAssets(targets: ReleaseTarget[], root?: string): ReleaseAsset[];
  assetNameProblems(assets: ReleaseAsset[]): string[];
  assetFileProblems(assets: ReleaseAsset[]): string[];
  changelogSection(changelog: string, version: string): string | undefined;
  releaseNotes(notes: ReleaseNotes): string;
}

interface ReleaseUtils {
  readRelease(): Promise<{ binaryName: string; packageName: string; targets: ReleaseTarget[] }>;
}

// The scripts have no declaration files, so a literal specifier would not
// type-check; the modules are loaded through their URLs and typed here
// instead.
const GITHUB_RELEASE = pathToFileURL(resolve(__dirname, '../scripts/github-release.mjs')).href;
const RELEASE_UTILS = pathToFileURL(resolve(__dirname, '../scripts/release-utils.mjs')).href;

let release: GitHubRelease;
let readRelease: ReleaseUtils['readRelease'];

beforeAll(async () => {
  release = (await import(GITHUB_RELEASE)) as GitHubRelease;
  ({ readRelease } = (await import(RELEASE_UTILS)) as ReleaseUtils);
});

/** A target as readRelease() describes it, with its package below `root`. */
function target(abi: string, root = '/repo'): ReleaseTarget {
  return {
    triple: `triple-of-${abi}`,
    abi,
    artifact: `comprs.${abi}.node`,
    packageName: `@scope/comprs-${abi}`,
    packageDir: join(root, 'npm', abi),
  };
}

describe('releaseAssets', () => {
  it('attaches LICENSE once, and each binary with its notice under a name of its own', () => {
    expect(
      release.releaseAssets([target('linux-x64-gnu'), target('win32-x64-msvc')], '/repo'),
    ).toEqual([
      { name: 'LICENSE', source: join('/repo', 'LICENSE') },
      {
        name: 'comprs.linux-x64-gnu.node',
        source: join('/repo', 'npm', 'linux-x64-gnu', 'comprs.linux-x64-gnu.node'),
      },
      {
        name: 'THIRD_PARTY_LICENSES.linux-x64-gnu.txt',
        source: join('/repo', 'npm', 'linux-x64-gnu', 'THIRD_PARTY_LICENSES'),
      },
      {
        name: 'comprs.win32-x64-msvc.node',
        source: join('/repo', 'npm', 'win32-x64-msvc', 'comprs.win32-x64-msvc.node'),
      },
      {
        name: 'THIRD_PARTY_LICENSES.win32-x64-msvc.txt',
        source: join('/repo', 'npm', 'win32-x64-msvc', 'THIRD_PARTY_LICENSES'),
      },
    ]);
  });

  it('gives every napi target of package.json asset names that no other asset has', async () => {
    const { targets } = await readRelease();
    const assets = release.releaseAssets(targets);
    expect(assets).toHaveLength(1 + 2 * targets.length);
    expect(release.assetNameProblems(assets)).toEqual([]);
  });
});

describe('assetNameProblems', () => {
  it('reports a name that two assets share, once for each further asset', () => {
    const assets = release.releaseAssets([
      target('linux-x64-gnu'),
      target('linux-x64-gnu'),
      target('linux-x64-gnu'),
    ]);
    expect(release.assetNameProblems(assets)).toEqual([
      'Two assets are named comprs.linux-x64-gnu.node',
      'Two assets are named THIRD_PARTY_LICENSES.linux-x64-gnu.txt',
      'Two assets are named comprs.linux-x64-gnu.node',
      'Two assets are named THIRD_PARTY_LICENSES.linux-x64-gnu.txt',
    ]);
  });

  it('reports names that differ only in case', () => {
    const assets = [
      { name: 'LICENSE', source: '/repo/LICENSE' },
      { name: 'license', source: '/repo/npm/x/LICENSE' },
    ];
    expect(release.assetNameProblems(assets)).toEqual([
      'Two assets are named license and LICENSE, which differ only in case',
    ]);
  });

  it.each([
    ['a space', 'comprs.linux x64.node'],
    ['a slash', 'npm/linux-x64-gnu/THIRD_PARTY_LICENSES'],
    ['a plus sign', 'comprs.linux+x64.node'],
    ['a leading period', '.comprs.node'],
    ['a trailing period', 'comprs.node.'],
    ['nothing', ''],
  ])('reports a name with %s, which GitHub would change', (_, name) => {
    expect(release.assetNameProblems([{ name, source: '/repo/file' }])).toEqual([
      `The asset name "${name}" has characters that GitHub replaces; use letters, digits, ` +
        '"-", "_" and ".", but no "." at either end',
    ]);
  });
});

describe('assetFileProblems', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'comprs-github-release-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports each file that is missing or not a file', () => {
    const linux = target('linux-x64-gnu', dir);
    const darwin = target('darwin-arm64', dir);
    writeFileSync(join(dir, 'LICENSE'), 'MIT');
    mkdirSync(linux.packageDir, { recursive: true });
    writeFileSync(join(linux.packageDir, linux.artifact), 'binary');
    mkdirSync(join(darwin.packageDir, 'THIRD_PARTY_LICENSES'), { recursive: true });
    writeFileSync(join(darwin.packageDir, darwin.artifact), 'binary');

    expect(release.assetFileProblems(release.releaseAssets([linux, darwin], dir))).toEqual([
      `THIRD_PARTY_LICENSES.linux-x64-gnu.txt: ${join(linux.packageDir, 'THIRD_PARTY_LICENSES')} does not exist`,
      `THIRD_PARTY_LICENSES.darwin-arm64.txt: ${join(darwin.packageDir, 'THIRD_PARTY_LICENSES')} is not a file`,
    ]);
  });

  it('accepts files that all exist', () => {
    const linux = target('linux-x64-gnu', dir);
    writeFileSync(join(dir, 'LICENSE'), 'MIT');
    mkdirSync(linux.packageDir, { recursive: true });
    writeFileSync(join(linux.packageDir, linux.artifact), 'binary');
    writeFileSync(join(linux.packageDir, 'THIRD_PARTY_LICENSES'), 'notices');

    expect(release.assetFileProblems(release.releaseAssets([linux], dir))).toEqual([]);
  });
});

/**
 * A changelog as changesets writes it, which indents the lines of an entry
 * after its first, plus a code block that someone wrote at the start of the
 * line.
 */
const CHANGELOG = `# comprs

## 2.1.0

### Minor Changes

- 1234567: Add a feature.

  \`\`\`js
  // An example:
  # comprs
  \`\`\`

### Patch Changes

- 89abcde: Fix a bug.

\`\`\`sh
# A comment, not a heading
## 2.0.9
\`\`\`

## 2.0.20

### Patch Changes

- fedcba9: Fix another bug.

## 2.0.2

### Patch Changes

- 7654321: Fix the first bug.

## 2.0.1

## 2.0.0
`;

describe('changelogSection', () => {
  it('returns the lines below the heading of the version, up to the next version', () => {
    expect(release.changelogSection(CHANGELOG, '2.1.0')).toBe(
      [
        '### Minor Changes',
        '',
        '- 1234567: Add a feature.',
        '',
        '  ```js',
        '  // An example:',
        '  # comprs',
        '  ```',
        '',
        '### Patch Changes',
        '',
        '- 89abcde: Fix a bug.',
        '',
        '```sh',
        '# A comment, not a heading',
        '## 2.0.9',
        '```',
      ].join('\n'),
    );
  });

  it('does not end the section at a heading in the text of a changeset', () => {
    const changelog = [
      '## 3.0.0',
      '',
      '### Major Changes',
      '',
      '- 1234567: Drop the CommonJS entry points.',
      '',
      '  ## Migration',
      '',
      '  Load the package with `import`.',
      '',
      '## 2.0.2',
      '',
    ].join('\n');
    expect(release.changelogSection(changelog, '3.0.0')).toBe(
      [
        '### Major Changes',
        '',
        '- 1234567: Drop the CommonJS entry points.',
        '',
        '  ## Migration',
        '',
        '  Load the package with `import`.',
      ].join('\n'),
    );
  });

  it('matches the whole version, not a prefix of it', () => {
    expect(release.changelogSection(CHANGELOG, '2.0.2')).toBe(
      '### Patch Changes\n\n- 7654321: Fix the first bug.',
    );
    expect(release.changelogSection(CHANGELOG, '2.0.20')).toBe(
      '### Patch Changes\n\n- fedcba9: Fix another bug.',
    );
  });

  it('reads a changelog with CRLF line endings', () => {
    expect(release.changelogSection(CHANGELOG.replaceAll('\n', '\r\n'), '2.0.2')).toBe(
      '### Patch Changes\n\n- 7654321: Fix the first bug.',
    );
  });

  it('returns undefined for a version without a section, or with an empty one', () => {
    expect(release.changelogSection(CHANGELOG, '3.0.0')).toBeUndefined();
    expect(release.changelogSection(CHANGELOG, '2.0.1')).toBeUndefined();
    expect(release.changelogSection(CHANGELOG, '2.0.0')).toBeUndefined();
  });

  it('ignores a heading of the version inside a fenced code block', () => {
    expect(release.changelogSection(CHANGELOG, '2.0.9')).toBeUndefined();
  });
});

describe('releaseNotes', () => {
  const notes = {
    changelogUrl: 'https://github.com/owner/repo/blob/v2.0.2/CHANGELOG.md',
    binaryName: 'comprs',
    packageName: '@scope/comprs',
  };

  it('puts the changelog section first, then describes the assets', () => {
    expect(release.releaseNotes({ ...notes, section: '### Patch Changes\n\n- Fix.' })).toBe(
      [
        '### Patch Changes',
        '',
        '- Fix.',
        '',
        '### Release assets',
        '',
        'Each `comprs.<abi>.node` is the native addon of the npm package ' +
          '`@scope/comprs-<abi>`. `THIRD_PARTY_LICENSES.<abi>.txt` holds the license ' +
          'notices of the third-party code that it links statically, and `LICENSE` is the ' +
          'license of `@scope/comprs`.',
        '',
      ].join('\n'),
    );
  });

  it('links to the changelog without a section', () => {
    expect(release.releaseNotes({ ...notes, section: undefined })).toMatch(
      /^See \[CHANGELOG\.md\]\(https:\/\/github\.com\/owner\/repo\/blob\/v2\.0\.2\/CHANGELOG\.md\) for the changes in this version\.\n\n### Release assets\n/,
    );
  });
});
