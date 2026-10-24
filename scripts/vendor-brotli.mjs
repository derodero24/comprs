#!/usr/bin/env node

/**
 * Vendor the C sources of libbrotli, Google's brotli library, into
 * crates/brotli-c/brotli, which crates/brotli-c builds (#563).
 *
 * It clones the release tag `v${BROTLI_VERSION}` of
 * https://github.com/google/brotli and copies the library's sources and
 * headers (c/common, c/dec, c/enc and c/include, `.c` and `.h` files only)
 * and its LICENSE, replacing what is there. Nothing else of the release is
 * vendored: neither the command-line tool, the bindings for other languages
 * nor the tests.
 *
 * Renovate updates BROTLI_VERSION in a pull request; `--check`, which CI
 * runs, then fails until this script has been run on that branch.
 *
 * Usage:
 *   node scripts/vendor-brotli.mjs           Vendor BROTLI_VERSION.
 *   node scripts/vendor-brotli.mjs --check   Exit with 1 if the vendored
 *                                            sources differ from it.
 */

import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';

// renovate: datasource=github-tags depName=google/brotli extractVersion=^v(?<version>.+)$
const BROTLI_VERSION = '1.2.1';

const REPOSITORY = 'https://github.com/google/brotli';
const ROOT = join(import.meta.dirname, '..');
const VENDOR_DIR = join(ROOT, 'crates', 'brotli-c', 'brotli');
/** The directories of the release whose `.c` and `.h` files are vendored. */
const SOURCE_DIRS = ['c/common', 'c/dec', 'c/enc', 'c/include/brotli'];
/** The other files of the release that are vendored. */
const FILES = ['LICENSE'];

const { values } = parseArgs({ options: { check: { type: 'boolean', default: false } } });

/**
 * Whether the release file at `path`, relative to the release root, is
 * vendored.
 *
 * @param {string} path
 * @returns {boolean}
 */
function isVendored(path) {
  if (FILES.includes(path)) {
    return true;
  }
  const dir = path.slice(0, path.lastIndexOf('/'));
  return SOURCE_DIRS.includes(dir) && /\.[ch]$/.test(path);
}

/**
 * The files under `dir`, relative to it, with `/` as the separator, sorted.
 *
 * @param {string} dir
 * @returns {string[]}
 */
function listFiles(dir) {
  /** @type {string[]} */
  const files = [];
  /** @param {string} current */
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile()) {
        files.push(relative(dir, path).split('\\').join('/'));
      }
    }
  };
  walk(dir);
  return files.sort();
}

const checkout = mkdtempSync(join(tmpdir(), 'comprs-brotli-'));
try {
  execFileSync(
    'git',
    [
      '-c',
      'advice.detachedHead=false',
      'clone',
      '--quiet',
      '--depth',
      '1',
      '--branch',
      `v${BROTLI_VERSION}`,
      REPOSITORY,
      checkout,
    ],
    { stdio: 'inherit' },
  );
  const release = listFiles(checkout).filter(isVendored);
  const version = readFileSync(join(checkout, 'c/common/version.h'), 'utf8');
  const [major, minor, patch] = BROTLI_VERSION.split('.');
  for (const [name, value] of [
    ['MAJOR', major],
    ['MINOR', minor],
    ['PATCH', patch],
  ]) {
    if (!new RegExp(`#define BROTLI_VERSION_${name} ${value}\\b`).test(version)) {
      throw new Error(`c/common/version.h of v${BROTLI_VERSION} does not say ${BROTLI_VERSION}`);
    }
  }

  if (values.check) {
    const vendored = statSync(VENDOR_DIR, { throwIfNoEntry: false })?.isDirectory()
      ? listFiles(VENDOR_DIR)
      : [];
    const differences = [
      ...release.filter((path) => !vendored.includes(path)).map((path) => `missing: ${path}`),
      ...vendored.filter((path) => !release.includes(path)).map((path) => `extra: ${path}`),
      ...release
        .filter((path) => vendored.includes(path))
        .filter(
          (path) =>
            !readFileSync(join(checkout, path)).equals(readFileSync(join(VENDOR_DIR, path))),
        )
        .map((path) => `changed: ${path}`),
    ];
    if (differences.length > 0) {
      console.error(
        `crates/brotli-c/brotli differs from libbrotli ${BROTLI_VERSION}:\n` +
          `${differences.map((line) => `  ${line}`).join('\n')}\n` +
          'Run node scripts/vendor-brotli.mjs to vendor it.',
      );
      process.exit(1);
    }
    console.log(`crates/brotli-c/brotli is libbrotli ${BROTLI_VERSION}.`);
  } else {
    rmSync(VENDOR_DIR, { recursive: true, force: true });
    for (const path of release) {
      cpSync(join(checkout, path), join(VENDOR_DIR, path));
    }
    console.log(`Vendored libbrotli ${BROTLI_VERSION}: ${release.length} files.`);
  }
} finally {
  rmSync(checkout, { recursive: true, force: true });
}
