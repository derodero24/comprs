#!/usr/bin/env node

/**
 * Generate THIRD_PARTY_LICENSES, the license notices of the third-party code
 * that an npm package ships compiled.
 *
 * The native addon of each platform package and the WebAssembly module of
 * the root package statically link Rust crates, and zstd-sys builds the zstd
 * C library into them. Most of their licenses (BSD-3-Clause, MIT and others)
 * require their notices to accompany the binaries. prepare-release.mjs writes
 * a notice into each package, and check-release.mjs compares each one with a
 * fresh generation. They are generated rather than committed, so that the
 * Cargo.lock updates of Renovate need no regenerated file.
 *
 * A notice lists the crates that `cargo tree` resolves for the build: the
 * normal dependencies of the crate that the package's build compiles, for
 * the build's target, without the build-time and proc-macro crates, which are
 * not linked in. Their license files come from the crate sources that
 * `cargo metadata` locates, which cargo downloads the first time (the script
 * needs `cargo`, and network access then). A crate that publishes no license
 * file gets the committed copy of its repository's license from
 * scripts/licenses/ (OVERRIDES); any other crate without one fails the
 * generation. A bundled C file whose header carries a copyright notice that
 * the crate's license files lack adds a committed copy of that header
 * (SOURCE_NOTICES).
 *
 * Usage:
 *   node scripts/third-party-licenses.mjs --package <comprs|comprs-wasm> --target <triple> [--output <file>]
 *
 *   --package  comprs for the native addon of a platform package, or
 *              comprs-wasm for the WebAssembly module of the root package.
 *   --target   Rust target triple: one of `napi.targets` in package.json for
 *              comprs, wasm32-unknown-unknown for comprs-wasm.
 *   --output   File to write the notice to, instead of standard output.
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { capture, isRecord, ROOT, readRelease, runMain } from './release-utils.mjs';

/** @typedef {import('./release-utils.mjs').ReleaseTarget} ReleaseTarget */

/**
 * A crate as `cargo tree` prints it.
 *
 * @typedef {object} CrateId
 * @property {string} name
 * @property {string} version
 */

/**
 * The fields of a `cargo metadata` package that the notice needs.
 *
 * @typedef {object} CargoPackage
 * @property {string} name
 * @property {string} version
 * @property {string | null} license SPDX license expression.
 * @property {string | null} licenseFile `license-file`, relative to the crate.
 * @property {string | null} repository
 * @property {string | null} source Where the crate comes from, such as the
 *   crates.io registry; null for the crates of this workspace.
 * @property {string} manifestPath Path of the crate's Cargo.toml.
 */

/**
 * A license text, and the file it comes from: a path in the crate's sources
 * (for a SOURCE_NOTICES entry, the source file whose header it copies), or
 * the URL of the upstream file that an override copies.
 *
 * @typedef {object} LicenseText
 * @property {string} file
 * @property {string} text
 */

/**
 * A crate that a notice lists.
 *
 * @typedef {object} NoticeCrate
 * @property {string} name
 * @property {string} version
 * @property {string | null} license
 * @property {string | null} repository
 * @property {LicenseText[]} texts
 */

/** File name of the notices in the npm packages. */
export const NOTICE_FILE = 'THIRD_PARTY_LICENSES';

/** The crate of the native addon, which `napi build` builds (crates/core). */
const NATIVE_CRATE = 'comprs';

/** The crate of the WebAssembly module, which wasm-pack builds (crates/wasm). */
const WASM_CRATE = 'comprs-wasm';

/** The only target of the WebAssembly build. */
const WASM_TARGET = 'wasm32-unknown-unknown';

/** Names of license files at the root of a crate. */
const LICENSE_FILE = /^(licen[cs]e|copying|notice|copyright|unlicense)([.-].*)?$/i;

/**
 * License files below the root of a crate, such as those of bundled C code,
 * by crate name, relative to the crate. Generation fails if one is missing.
 *
 * zstd-sys builds the zstd C library from its sources. zstd/LICENSE holds
 * Meta's BSD license, which covers most of them; the files whose headers
 * carry other copyright notices are in SOURCE_NOTICES. zstd is dual-licensed
 * and used under that BSD license, so zstd/COPYING, the GPLv2 alternative,
 * is left out. brotli needs no entry: it is a Rust port that bundles no C
 * code, and its own LICENSE.MIT (the Brotli Authors) and
 * LICENSE.BSD-3-Clause (Dropbox) carry both notices.
 *
 * @type {Map<string, string[]>}
 */
const EXTRA_FILES = new Map([['zstd-sys', ['zstd/LICENSE']]]);

/** Committed copies of upstream texts, for OVERRIDES and SOURCE_NOTICES. */
const LICENSES_DIR = join(import.meta.dirname, 'licenses');

/**
 * Notices that a crate needs besides its license files, by crate name: the
 * copyright notices in the headers of bundled source files that its license
 * files do not carry. Each entry names a source file, relative to the crate,
 * and a committed text in scripts/licenses/ that says where the header
 * comes from and ends with a verbatim copy of it; the notice lists that
 * text for the source file. Generation fails when a source file is missing,
 * or no longer starts with the header that its copy ends with, so that a
 * crate update that changes a header also updates the copy.
 *
 * zstd-sys compiles every C file of zstd/lib/common, compress, decompress
 * and, with the zdict_builder feature that every build enables,
 * dictBuilder (but not xxhash.c). Their headers name Meta alone, as
 * zstd/LICENSE does, except for:
 *
 *   - threading.c and threading.h (Tino Reichardt), the Windows thread
 *     wrappers that the native Windows builds link, as comprs-core enables
 *     zstdmt (ZSTD_MULTITHREAD); elsewhere they compile to almost nothing;
 *   - xxhash.h (Yann Collet - Meta Platforms), whose hash functions every
 *     build inlines;
 *   - divsufsort.c (Yuta Mori, MIT), which the dictionary builder compiles,
 *     although only the legacy trainer, which comprs does not call, uses it.
 *
 * They are listed for every build that links zstd-sys, not only where the
 * linker keeps their code: a notice too many does no harm, and one too few
 * would.
 *
 * @type {Map<string, { source: string, copy: string }[]>}
 */
const SOURCE_NOTICES = new Map([
  [
    'zstd-sys',
    [
      { source: 'zstd/lib/common/threading.c', copy: 'zstd-threading.NOTICE' },
      { source: 'zstd/lib/common/threading.h', copy: 'zstd-threading.NOTICE' },
      { source: 'zstd/lib/common/xxhash.h', copy: 'zstd-xxhash.NOTICE' },
      { source: 'zstd/lib/dictBuilder/divsufsort.c', copy: 'zstd-divsufsort.NOTICE' },
    ],
  ],
]);

/**
 * The repository license of napi and napi-sys: napi-rs/napi-rs at the tags
 * napi-v3.14.0 and napi-sys-v3.4.0, which name the same commit.
 */
const NAPI_RS_LICENSE = {
  copy: 'napi-rs.LICENSE',
  upstream:
    'https://github.com/napi-rs/napi-rs/blob/37109f133043aff379a38edfb8b1548e7e9309e5/LICENSE',
};

/**
 * The license of crates/sys, the directory of napi-sys, at the same commit.
 * It carries a notice that the repository's LICENSE does not, David
 * Herman's, so napi-sys ships both.
 */
const NAPI_SYS_LICENSE = {
  copy: 'napi-sys.LICENSE',
  upstream:
    'https://github.com/napi-rs/napi-rs/blob/37109f133043aff379a38edfb8b1548e7e9309e5/crates/sys/LICENSE',
};

/**
 * The repository license of alloc-stdlib: dropbox/rust-alloc-no-stdlib at
 * the tag 0.3.0. alloc-no-stdlib ships the same file.
 */
const ALLOC_STDLIB_LICENSE = {
  copy: 'rust-alloc-no-stdlib.LICENSE',
  upstream:
    'https://github.com/dropbox/rust-alloc-no-stdlib/blob/0a81fd6928ea3b33c8cd484aa4575d50ffb98012/LICENSE',
};

/**
 * License files for the crates that publish none, by crate name, without a
 * version so that updates keep them: verbatim copies of the license files of
 * their repositories, in scripts/licenses/. They are used only while a crate
 * ships no license file of its own.
 *
 * @type {Map<string, { copy: string, upstream: string }[]>}
 */
const OVERRIDES = new Map([
  ['napi', [NAPI_RS_LICENSE]],
  ['napi-sys', [NAPI_RS_LICENSE, NAPI_SYS_LICENSE]],
  ['alloc-stdlib', [ALLOC_STDLIB_LICENSE]],
]);

/** The opening paragraph of each notice, after its title. */
const INTRODUCTION = [
  'comprs itself is licensed under the MIT license (see LICENSE). The compiled',
  'code in this package, a native addon or a WebAssembly module, statically',
  'links the Rust crates listed below, including the zstd C library that the',
  'zstd-sys crate builds, and their licenses follow. Crates that run only at',
  'build time, such as build scripts and procedural macros, are not linked in',
  'and are not listed. A crate that publishes no license file is listed with',
  'the license file of its repository.',
];

/** The line before each license text. */
const SEPARATOR = '='.repeat(78);

/**
 * The notice of the root package, for the crates that its WebAssembly module
 * (browser/comprs-wasm_bg.wasm) links.
 *
 * @param {string} packageName Name of the root package.
 * @returns {string}
 */
export function rootNotice(packageName) {
  return thirdPartyNotice({
    cargoPackage: WASM_CRATE,
    target: WASM_TARGET,
    npmPackage: packageName,
  });
}

/**
 * The notice of a platform package, for the crates that its native addon
 * links.
 *
 * @param {ReleaseTarget} target
 * @returns {string}
 */
export function platformNotice(target) {
  return thirdPartyNotice({
    cargoPackage: NATIVE_CRATE,
    target: target.triple,
    npmPackage: target.packageName,
  });
}

/**
 * Generate the notice of an npm package for the build of a crate.
 *
 * @param {{ cargoPackage: string, target: string, npmPackage: string }} build
 * @returns {string}
 */
export function thirdPartyNotice({ cargoPackage, target, npmPackage }) {
  const crates = collectLicenses(linkedCrates(cargoPackage, target), cargoMetadata());
  return renderNotice({ title: `${npmPackage} (${target})`, crates });
}

/**
 * List the crates that a build links. `-p` resolves the features of that
 * crate alone, as `napi build` and wasm-pack do, which build one crate; a
 * walk of the `cargo metadata` resolve graph would unify the features of the
 * whole workspace instead. `--target` needs no installed target, and cargo
 * downloads any crate it does not have yet. `--color never` keeps the
 * ` (*)` markers plain where CARGO_TERM_COLOR asks for color, as it does in
 * CI.
 *
 * @param {string} cargoPackage
 * @param {string} target
 * @returns {CrateId[]}
 */
function linkedCrates(cargoPackage, target) {
  return parseCargoTree(
    capture('cargo', [
      'tree',
      '--color',
      'never',
      '--locked',
      '-p',
      cargoPackage,
      '--target',
      target,
      '-e',
      'normal,no-proc-macro',
      '--prefix',
      'none',
      '--format',
      '{p}',
    ]),
  );
}

/** A line of `cargo tree --prefix none --format {p}`, without ` (*)`. */
const TREE_LINE = /^([\w-]+) v(\S+)(?: \(.*\))?$/;

/**
 * Read the output of `cargo tree --prefix none --format {p}`: a line such as
 * `name v1.2.3`, followed by ` (<path or registry>)` for some crates and by
 * ` (*)` where the tree repeats a crate. Return each crate once.
 *
 * @param {string} output
 * @returns {CrateId[]}
 */
export function parseCargoTree(output) {
  /** @type {Map<string, CrateId>} */
  const crates = new Map();
  for (const line of output.split('\n')) {
    const entry = line.trim().replace(/ \(\*\)$/, '');
    if (entry === '') {
      continue;
    }
    const [, name, version] = TREE_LINE.exec(entry) ?? [];
    if (name === undefined || version === undefined) {
      throw new Error(`Unexpected line in the cargo tree output: ${line}`);
    }
    crates.set(`${name} ${version}`, { name, version });
  }
  return [...crates.values()];
}

/** @type {CargoPackage[] | undefined} */
let metadata;

/**
 * The packages of `cargo metadata`, once per process. Without --no-deps and
 * --filter-platform, it lists every crate in Cargo.lock.
 *
 * @returns {CargoPackage[]}
 */
function cargoMetadata() {
  metadata ??= parseCargoMetadata(
    capture('cargo', ['metadata', '--locked', '--format-version', '1'], {
      maxBuffer: 64 * 1024 * 1024,
    }),
  );
  return metadata;
}

/**
 * Read the packages of `cargo metadata --format-version 1`.
 *
 * @param {string} output
 * @returns {CargoPackage[]}
 */
export function parseCargoMetadata(output) {
  /** @type {unknown} */
  const parsed = JSON.parse(output);
  const packages = isRecord(parsed) ? parsed['packages'] : undefined;
  if (!Array.isArray(packages)) {
    throw new Error('The cargo metadata output lists no packages');
  }
  /** @type {unknown[]} */
  const entries = packages;
  return entries.map(cargoPackage);
}

/**
 * @param {unknown} entry
 * @returns {CargoPackage}
 */
function cargoPackage(entry) {
  /** @type {Record<string, unknown>} */
  const fields = isRecord(entry) ? entry : {};
  const { name, version, manifest_path: manifestPath } = fields;
  if (typeof name !== 'string' || typeof version !== 'string' || typeof manifestPath !== 'string') {
    throw new Error(`Unexpected package in the cargo metadata output: ${JSON.stringify(entry)}`);
  }
  return {
    name,
    version,
    license: optionalString(fields['license']),
    licenseFile: optionalString(fields['license_file']),
    repository: optionalString(fields['repository']),
    source: optionalString(fields['source']),
    manifestPath,
  };
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function optionalString(value) {
  return typeof value === 'string' ? value : null;
}

/**
 * Find the license texts of the crates that a build links, and leave out
 * the crates of this workspace, comprs's own code, which LICENSE covers.
 * Throws if a crate has no license text, naming every such crate.
 *
 * @param {CrateId[]} crates
 * @param {CargoPackage[]} packages
 * @returns {NoticeCrate[]}
 */
export function collectLicenses(crates, packages) {
  const byId = new Map(packages.map((pkg) => [`${pkg.name} ${pkg.version}`, pkg]));
  /** @type {NoticeCrate[]} */
  const found = [];
  /** @type {string[]} */
  const unlicensed = [];
  for (const { name, version } of crates) {
    const pkg = byId.get(`${name} ${version}`);
    if (pkg === undefined) {
      throw new Error(`cargo metadata does not list ${name} ${version}, which cargo tree does`);
    }
    if (pkg.source === null) {
      continue;
    }
    const texts = licenseTexts(pkg);
    if (texts.length === 0) {
      unlicensed.push(`${name} ${version}`);
    } else {
      texts.push(...sourceNotices(pkg));
      found.push({ name, version, license: pkg.license, repository: pkg.repository, texts });
    }
  }
  if (unlicensed.length > 0) {
    throw new Error(
      `No license text for ${unlicensed.join(', ')}: no license file in the crate sources. ` +
        "Add a verbatim copy of the license file of each crate's repository to " +
        'scripts/licenses/, and an entry for it to OVERRIDES in scripts/third-party-licenses.mjs ' +
        '(or, for a license file elsewhere in the crate, an entry to EXTRA_FILES).',
    );
  }
  return found;
}

/**
 * Read the license texts of a crate: the license files at its root, the
 * file that its `license-file` names and its EXTRA_FILES, or else those of
 * its OVERRIDES entry. Empty files do not count.
 *
 * @param {CargoPackage} pkg
 * @returns {LicenseText[]}
 */
function licenseTexts(pkg) {
  const dir = dirname(pkg.manifestPath);
  const files = [
    ...new Set([...licenseFiles(dir), ...declaredLicenseFile(pkg, dir), ...extraFiles(pkg, dir)]),
  ].sort();
  const texts = files
    .map((file) => ({ file, text: readText(join(dir, file)) }))
    .filter(({ text }) => text !== '');
  if (texts.length > 0) {
    return texts;
  }
  return (OVERRIDES.get(pkg.name) ?? []).map(({ copy, upstream }) => ({
    file: upstream,
    text: readText(join(LICENSES_DIR, copy)),
  }));
}

/**
 * The regular files at the root of a crate whose names mark license files.
 *
 * @param {string} dir
 * @returns {string[]}
 */
function licenseFiles(dir) {
  return readdirSync(dir).filter((file) => LICENSE_FILE.test(file) && isFile(join(dir, file)));
}

/**
 * The file that a crate's `license-file` names, as a `/`-separated path
 * relative to the crate, if the crate's sources hold it. Older crates may
 * name a file outside the published crate, such as `../LICENSE`: such a
 * crate is left with its other license files, or else with its OVERRIDES
 * entry, or fails in collectLicenses() without either.
 *
 * @param {CargoPackage} pkg
 * @param {string} dir
 * @returns {string[]}
 */
function declaredLicenseFile(pkg, dir) {
  if (pkg.licenseFile === null) {
    return [];
  }
  const file = relative(dir, resolve(dir, pkg.licenseFile)).replaceAll('\\', '/');
  if (isFile(join(dir, file))) {
    return [file];
  }
  console.warn(
    `warning: ${pkg.name} ${pkg.version} names the license file ${pkg.licenseFile}, ` +
      `which is not in ${dir}; it is left out`,
  );
  return [];
}

/**
 * The EXTRA_FILES of a crate, as `/`-separated paths relative to the crate.
 * Throws if one is missing.
 *
 * @param {CargoPackage} pkg
 * @param {string} dir
 * @returns {string[]}
 */
function extraFiles(pkg, dir) {
  const files = EXTRA_FILES.get(pkg.name) ?? [];
  for (const file of files) {
    if (!isFile(join(dir, file))) {
      throw new Error(`${pkg.name} ${pkg.version} has no ${file} in ${dir}`);
    }
  }
  return files;
}

/**
 * The SOURCE_NOTICES of a crate, each with the source file whose header it
 * copies. Throws if a source file is missing, or does not start with the
 * header that its copy ends with.
 *
 * @param {CargoPackage} pkg
 * @returns {LicenseText[]}
 */
function sourceNotices(pkg) {
  const dir = dirname(pkg.manifestPath);
  return (SOURCE_NOTICES.get(pkg.name) ?? []).map(({ source, copy }) => {
    const copyPath = relative(ROOT, join(LICENSES_DIR, copy)).replaceAll('\\', '/');
    if (!isFile(join(dir, source))) {
      throw new Error(
        `${pkg.name} ${pkg.version} has no ${source} in ${dir}, whose header ${copyPath} ` +
          'copies; update or remove its SOURCE_NOTICES entry in scripts/third-party-licenses.mjs',
      );
    }
    const text = readText(join(LICENSES_DIR, copy));
    const header = leadingComment(readText(join(dir, source)));
    if (header === undefined || !text.endsWith(header)) {
      throw new Error(
        `The header of ${source} in ${pkg.name} ${pkg.version} is not the one that ` +
          `${copyPath} copies; copy the new header into it verbatim`,
      );
    }
    return { file: source, text };
  });
}

/**
 * The block comment that a C source file starts with, if any, up to the end
 * of that comment.
 *
 * @param {string} text
 * @returns {string | undefined}
 */
function leadingComment(text) {
  const end = text.indexOf('*/');
  return text.startsWith('/*') && end !== -1 ? text.slice(0, end + 2) : undefined;
}

/**
 * Whether a path is a regular file, or a link to one.
 *
 * @param {string} path
 * @returns {boolean}
 */
function isFile(path) {
  return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
}

/**
 * @param {string} path
 * @returns {string}
 */
function readText(path) {
  return normalizeText(readFileSync(path, 'utf8'));
}

/**
 * Normalize a license text, so that copies that differ only in line endings
 * or trailing whitespace are the same: without a byte order mark, with LF
 * line endings, and without whitespace at the end of each line and of the
 * text.
 *
 * @param {string} text
 * @returns {string}
 */
function normalizeText(text) {
  return text
    .replace(/^\uFEFF/, '')
    .replaceAll('\r\n', '\n')
    .replace(/[ \t]+$/gm, '')
    .trimEnd();
}

/**
 * Render a notice: its title, the index of the crates, then each distinct
 * license text once, after the crates and files that hold it. The output
 * depends on the crates and their texts alone, not on their order, and has
 * LF line endings and a final line feed.
 *
 * @param {{ title: string, crates: NoticeCrate[] }} notice
 * @returns {string}
 */
export function renderNotice({ title, crates }) {
  const sorted = [...crates].sort(
    (a, b) => compareStrings(a.name, b.name) || compareStrings(a.version, b.version),
  );
  const lines = [
    `Third-party licenses for ${title}`,
    '',
    ...INTRODUCTION,
    '',
    'Crates:',
    '',
    ...indexLines(sorted),
  ];
  for (const [text, users] of groupTexts(sorted)) {
    lines.push('', SEPARATOR, `Used by: ${users.join(', ')}`, '', text);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * The index of a notice, one line per crate, in aligned columns: name and
 * version, license expression, repository.
 *
 * @param {NoticeCrate[]} crates
 * @returns {string[]}
 */
function indexLines(crates) {
  const rows = crates.map((crate) => [
    `${crate.name} ${crate.version}`,
    crate.license ?? '(license file)',
    crate.repository ?? '',
  ]);
  const widths = [0, 1].map((column) =>
    Math.max(0, ...rows.map((row) => row[column]?.length ?? 0)),
  );
  return rows.map((row) =>
    `  ${row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join('  ')}`.trimEnd(),
  );
}

/**
 * Group the license texts of sorted crates by their normalized text, each
 * with the crates and files that hold it, in the order they first appear.
 *
 * @param {NoticeCrate[]} crates
 * @returns {Map<string, string[]>}
 */
function groupTexts(crates) {
  /** @type {Map<string, string[]>} */
  const groups = new Map();
  for (const crate of crates) {
    const texts = [...crate.texts].sort((a, b) => compareStrings(a.file, b.file));
    for (const { file, text } of texts) {
      const normalized = normalizeText(text);
      const users = groups.get(normalized) ?? [];
      users.push(`${crate.name} ${crate.version} (${file})`);
      groups.set(normalized, users);
    }
  }
  return groups;
}

/**
 * Compare strings by their UTF-16 code units, the same in every locale.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareStrings(a, b) {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

/**
 * The crates that the index of a notice lists, for checks of a rendered
 * notice.
 *
 * @param {string} notice
 * @returns {CrateId[]}
 */
export function indexedCrates(notice) {
  const lines = notice.split('\n');
  const start = lines.indexOf('Crates:') + 2;
  const end = lines.indexOf('', start);
  return lines.slice(start, end === -1 ? undefined : end).map((line) => {
    const [name = '', version = ''] = line.trim().split(' ');
    return { name, version };
  });
}

/**
 * Whether Node.js runs this file, rather than another module that imports
 * it.
 *
 * @returns {boolean}
 */
function isEntryPoint() {
  const [, entry] = process.argv;
  return entry !== undefined && existsSync(entry) && realpathSync(entry) === import.meta.filename;
}

/**
 * The notice that the release writes for a build: that of the root package
 * for the WebAssembly build, or that of the platform package of a napi
 * target.
 *
 * @param {import('./release-utils.mjs').Release} release
 * @param {string} cargoPackage
 * @param {string} triple
 * @returns {string}
 */
function packageNotice(release, cargoPackage, triple) {
  if (cargoPackage === WASM_CRATE) {
    if (triple !== WASM_TARGET) {
      throw new Error(`${WASM_CRATE} is built for ${WASM_TARGET} only, not for ${triple}`);
    }
    return rootNotice(release.packageName);
  }
  if (cargoPackage !== NATIVE_CRATE) {
    throw new Error(`--package must be ${NATIVE_CRATE} or ${WASM_CRATE}, not ${cargoPackage}`);
  }
  const target = release.targets.find((item) => item.triple === triple);
  if (target === undefined) {
    throw new Error(
      `${triple} is not a napi target; package.json lists ` +
        release.targets.map((item) => item.triple).join(', '),
    );
  }
  return platformNotice(target);
}

if (isEntryPoint()) {
  await runMain(async () => {
    const { values } = parseArgs({
      options: {
        package: { type: 'string' },
        target: { type: 'string' },
        output: { type: 'string' },
      },
      strict: true,
      allowPositionals: false,
    });
    const { package: cargoPackage, target, output } = values;
    if (cargoPackage === undefined || target === undefined) {
      throw new Error(
        'Usage: node scripts/third-party-licenses.mjs --package <comprs|comprs-wasm> ' +
          '--target <triple> [--output <file>]',
      );
    }
    const notice = packageNotice(await readRelease(), cargoPackage, target);
    if (output === undefined) {
      // A reader such as `head` may stop reading before the end.
      process.stdout.on('error', (error) => {
        if (!('code' in error) || error.code !== 'EPIPE') {
          throw error;
        }
      });
      process.stdout.write(notice);
    } else {
      writeFileSync(output, notice);
    }
  });
}
