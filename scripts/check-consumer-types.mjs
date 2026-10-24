#!/usr/bin/env node

/**
 * Type-check the package as a strict TypeScript consumer installs it (#566).
 *
 * Each directory of __test__/consumer-types is a small consumer project: an
 * ES module and a CommonJS one that resolve the package like Node.js does,
 * and three ES modules that resolve it like a bundler does. One of these has
 * the `browser` condition, the DOM library and no Node.js types (#567);
 * dom-only-next has the DOM library and no Node.js types either, but not the
 * condition, and passes the results of `@derodero24/comprs/next` to DOM
 * functions that take a BufferSource or a BlobPart (#577); es-only-next has
 * neither the DOM library nor Node.js types, which the declarations of
 * `@derodero24/comprs/next` must not need (#559). They type-check
 * their dependencies' declarations (`skipLibCheck: false`), which the
 * repository's own tsconfig.json skips, and they use the package by its
 * name, so that the `exports` conditions pick the declaration files.
 *
 * Each project's unscoped.ts imports the same entry points from the
 * unscoped `comprs` package as well (packages/comprs, #752), whose
 * declarations re-export those of @derodero24/comprs, and checks that both
 * give the same values and types.
 *
 * The script packs the root package and packages/comprs into temporary
 * tarballs, as `npm publish` would, extracts them into each project's
 * node_modules (gitignored) and type-checks the project with TypeScript 7
 * and TypeScript 5.9 (the `typescript-5` devDependency).
 * @types/node, for the projects that use it, resolves from the repository's
 * node_modules. It reports every failure, exits non-zero if there is any,
 * and removes what it installed.
 *
 * Usage:
 *   node scripts/check-consumer-types.mjs
 */

import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { group, npmPack, ROOT, readJson, run, runMain } from './release-utils.mjs';

const FIXTURES_DIR = join(ROOT, '__test__', 'consumer-types');

/** The directories of the packages that the consumer projects install. */
const PACKAGE_DIRS = [ROOT, join(ROOT, 'packages', 'comprs')];

/**
 * The compilers to check with. Both packages provide a `tsc` command, so each
 * one's own bin/tsc is run with Node.js rather than node_modules/.bin/tsc.
 */
const COMPILERS = [
  { name: 'TypeScript 7', tsc: join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc') },
  { name: 'TypeScript 5.9', tsc: join(ROOT, 'node_modules', 'typescript-5', 'bin', 'tsc') },
];

await runMain(async () => {
  const names = PACKAGE_DIRS.map((dir) => {
    const { name } = readJson(join(dir, 'package.json'));
    if (typeof name !== 'string') {
      throw new Error(`${relative(ROOT, join(dir, 'package.json'))} has no name`);
    }
    return name;
  });
  const fixtures = readdirSync(FIXTURES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (fixtures.length === 0) {
    throw new Error(`${relative(ROOT, FIXTURES_DIR)} holds no consumer projects`);
  }

  /** @type {string[]} */
  const failures = [];
  const workDir = mkdtempSync(join(tmpdir(), 'comprs-consumer-types-'));
  try {
    /** @type {string[]} */
    const tarballs = [];
    for (const [index, dir] of PACKAGE_DIRS.entries()) {
      tarballs.push(
        await group(`npm pack ${names[index]}`, () => {
          const { filename, files } = npmPack(dir, ['--pack-destination', workDir]);
          console.log(files.join('\n'));
          return join(workDir, filename);
        }),
      );
    }
    for (const fixture of fixtures) {
      const project = join(FIXTURES_DIR, fixture);
      rmSync(join(project, 'node_modules'), { recursive: true, force: true });
      for (const [index, tarball] of tarballs.entries()) {
        const installDir = join(project, 'node_modules', ...(names[index] ?? '').split('/'));
        mkdirSync(installDir, { recursive: true });
        run('tar', ['-xzf', tarball, '-C', installDir, '--strip-components=1']);
      }
      for (const compiler of COMPILERS) {
        await group(`${fixture}: ${compiler.name}`, () => {
          try {
            run(process.execPath, [compiler.tsc, '--project', relative(ROOT, project)]);
          } catch {
            failures.push(`${fixture} (${compiler.name})`);
          }
        });
      }
    }
  } finally {
    for (const fixture of fixtures) {
      rmSync(join(FIXTURES_DIR, fixture, 'node_modules'), { recursive: true, force: true });
    }
    rmSync(workDir, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    throw new Error(`Type errors in the consumer projects:\n${failures.join('\n')}`);
  }
  console.log(
    `\n${fixtures.length} consumer project(s) type-check with ${COMPILERS.map((compiler) => compiler.name).join(' and ')}.`,
  );
});
