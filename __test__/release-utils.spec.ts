import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

interface Manifest {
  path: string;
  json: Record<string, unknown>;
}

interface ReleaseUtils {
  repositoryUrlProblems(manifests: Manifest[]): string[];
}

// release-utils.mjs has no declaration file, so a literal specifier would not
// type-check; the module is loaded through its URL and typed here instead.
const RELEASE_UTILS = pathToFileURL(resolve(__dirname, '../scripts/release-utils.mjs')).href;

const REPOSITORY = 'https://github.com/derodero24/comprs';

let repositoryUrlProblems: ReleaseUtils['repositoryUrlProblems'];

beforeAll(async () => {
  ({ repositoryUrlProblems } = (await import(RELEASE_UTILS)) as ReleaseUtils);
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
