#!/usr/bin/env node

/**
 * Install @derodero24/comprs into the fixtures' node_modules from the
 * tarballs that the release would publish, so that every fixture imports the
 * package by name, through its `exports`, and gets the published files
 * rather than the working tree.
 *
 * Run scripts/prepare-release.mjs first, as the Package E2E job of
 * .github/workflows/ci.yml does: it assembles the root package (with the
 * wasm-bindgen build in browser/) and the npm/<platform> packages from the
 * build artifacts, as the release does. This script then:
 *
 *   1. packs the root package, and the platform package that npm would
 *      install on this machine by its `os`, `cpu` and `libc` fields, with
 *      `npm pack`, as the Release Dry Run job packs them;
 *   2. extracts each tarball into node_modules/<name>, which is all that a
 *      package manager does for a package without dependencies or install
 *      scripts. Installing the tarballs with pnpm would record their
 *      checksums, which change with every build, in pnpm-lock.yaml.
 *
 * Usage:
 *   node e2e/install-package.mjs
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  isRecord,
  npmPack,
  ROOT,
  readJson,
  readRelease,
  runMain,
} from '../scripts/release-utils.mjs';

/** @typedef {import('../scripts/release-utils.mjs').ReleaseTarget} ReleaseTarget */

const NODE_MODULES = join(import.meta.dirname, 'node_modules');

/** Fields of package.json that make a package manager install more than the tarball. */
const DEPENDENCY_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies'];

await runMain(async () => {
  const release = await readRelease();
  const declared = DEPENDENCY_FIELDS.filter((field) => field in release.packageJson);
  if (declared.length > 0) {
    throw new Error(
      `package.json declares ${declared.join(', ')}, which extracting the tarball does not install`,
    );
  }
  const target = hostTarget(release.targets);

  const packDir = mkdtempSync(join(tmpdir(), 'comprs-e2e-'));
  try {
    install(release.packageName, ROOT, packDir);
    install(target.packageName, target.packageDir, packDir);
  } finally {
    rmSync(packDir, { recursive: true, force: true });
  }
});

/**
 * Return the platform package that npm would install on this machine, and
 * check that prepare-release.mjs put its binary in it.
 *
 * @param {ReleaseTarget[]} targets
 * @returns {ReleaseTarget}
 */
function hostTarget(targets) {
  const libc = hostLibc();
  const matches = targets.filter((target) => {
    const manifest = readJson(join(target.packageDir, 'package.json'));
    return (
      allows(manifest['os'], process.platform) &&
      allows(manifest['cpu'], process.arch) &&
      (libc === undefined || allows(manifest['libc'], libc))
    );
  });
  const [target] = matches;
  if (target === undefined || matches.length > 1) {
    const found = matches.map((match) => match.packageName).join(', ') || 'none';
    throw new Error(
      `Expected one platform package for ${process.platform}-${process.arch}, found ${found}`,
    );
  }
  const binary = join(target.packageDir, target.artifact);
  if (!existsSync(binary)) {
    throw new Error(
      `${relative(ROOT, binary)} is missing; run scripts/prepare-release.mjs with the ` +
        `build artifact of ${target.triple} first`,
    );
  }
  return target;
}

/**
 * Whether an `os`, `cpu` or `libc` field of a package.json lets npm install
 * the package where that value applies. A missing field allows any value,
 * and `!value` excludes one.
 *
 * @param {unknown} field
 * @param {string} value
 */
function allows(field, value) {
  if (!Array.isArray(field)) {
    return true;
  }
  /** @type {unknown[]} */
  const entries = field;
  if (entries.includes(`!${value}`)) {
    return false;
  }
  return (
    entries.includes(value) ||
    entries.every((entry) => typeof entry === 'string' && entry.startsWith('!'))
  );
}

/**
 * Return the C library that npm matches the `libc` field against: `glibc`
 * or `musl` on Linux, and nothing elsewhere, where npm ignores the field.
 *
 * @returns {string | undefined}
 */
function hostLibc() {
  if (process.platform !== 'linux') {
    return undefined;
  }
  /** @type {unknown} */
  const report = process.report.getReport();
  const header = isRecord(report) ? report['header'] : undefined;
  return isRecord(header) && 'glibcVersionRuntime' in header ? 'glibc' : 'musl';
}

/**
 * Pack a package into `packDir` and extract the tarball into
 * node_modules/<name>, in place of what was there.
 *
 * @param {string} name
 * @param {string} packageDir
 * @param {string} packDir
 */
function install(name, packageDir, packDir) {
  const { filename, files } = npmPack(packageDir, ['--pack-destination', packDir]);
  const dest = join(NODE_MODULES, ...name.split('/'));
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  execFileSync('tar', ['-xzf', join(packDir, filename), '-C', dest, '--strip-components=1']);
  console.log(`Installed ${filename} (${files.length} files) in ${relative(ROOT, dest)}`);
}
