#!/usr/bin/env node

/**
 * Check the npm packages that prepare-release.mjs assembled, without
 * publishing anything.
 *
 * The `release-dry-run` job of .github/workflows/ci.yml runs this after
 * prepare-release.mjs on every CI run. It checks that:
 *
 *   1. every npm/<platform> package belongs to a napi target and has the root
 *      package's version. `napi prepublish` adds the native ones to the root
 *      package's optionalDependencies with that version, and any
 *      optionalDependencies already in package.json must agree;
 *   2. `napi prepublish --dry-run` accepts the platform packages, as the real
 *      publish (the prepublishOnly script) must;
 *   3. `npm pack --dry-run` of each platform package includes its binary and
 *      every file its manifest names;
 *   4. no platform binary needs more from the system than its package
 *      promises: the glibc builds need at most glibc 2.17, the musl builds
 *      no glibc, and the Windows builds link the C runtime statically
 *      instead of needing the Visual C++ Redistributable;
 *   5. the root package, packed into a temporary tarball, includes every file
 *      and entry point its package.json names and no platform binary, and
 *      its browser entry points (those of `.` and `./streams`) work with
 *      bundlers (#564): each one only loads files from the package itself,
 *      as ES modules, down to the wasm-bindgen WebAssembly module, which it
 *      fetches through `new URL('…', import.meta.url)` rather than importing
 *      it, and no `sideEffects` field lets a bundler drop its
 *      initialisation;
 *   6. publint and attw accept that tarball;
 *   7. the root package, every platform package and the middleware package
 *      name the same GitHub repository in `repository`. They are published
 *      with provenance, and npm rejects a package (E422) whose
 *      `repository.url` does not match the repository that the provenance
 *      names. `napi prepublish` publishes the platform packages before the
 *      root package, and the middleware is published last, so a mismatch in
 *      any of them would fail the release halfway.
 *
 * Usage:
 *   node scripts/check-release.mjs [--allow-missing-targets]
 *
 *   --allow-missing-targets  Skip the platform packages whose binary was not
 *                            built (steps 2 to 4), for CI runs that build
 *                            some targets. Without it, a missing binary is an
 *                            error.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import {
  annotate,
  browserEntryProblems,
  group,
  isRecord,
  napiTargetArgs,
  normalizePath,
  npmPack,
  ROOT,
  readJson,
  readRelease,
  repositoryUrlProblems,
  run,
  runMain,
  runTool,
} from './release-utils.mjs';

/** @typedef {import('./release-utils.mjs').Release} Release */
/** @typedef {import('./release-utils.mjs').ReleaseTarget} ReleaseTarget */
/** @typedef {{ major: number, minor: number }} GlibcVersion */

/**
 * Newest glibc that the glibc binaries may need. napi-cross (build.yml) links
 * them against glibc 2.17, as for every release so far. A build linked
 * against the build machine's own glibc needs that version instead (2.34 on
 * Ubuntu 24.04) and fails to load on older distributions.
 *
 * @type {GlibcVersion}
 */
const MAX_GLIBC = { major: 2, minor: 17 };

/**
 * DLLs of the dynamically linked Microsoft C runtime. A binary that imports
 * them fails to load where the Visual C++ Redistributable is not installed;
 * .cargo/config.toml links the C runtime statically instead.
 */
const DYNAMIC_CRT_DLL = /\b(?:vcruntime\d+|msvcp\d+|ucrtbased?|api-ms-win-crt-[a-z\d-]+)\.dll\b/gi;

/**
 * Problems found so far; any of them fails the run at the end.
 *
 * @type {string[]}
 */
const problems = [];

await runMain(async () => {
  const { values } = parseArgs({
    options: { 'allow-missing-targets': { type: 'boolean', default: false } },
    strict: true,
    allowPositionals: false,
  });
  const release = await readRelease();
  const targets = selectTargets(release.targets, values['allow-missing-targets']);
  const targetArgs = targets.length < release.targets.length ? napiTargetArgs(targets) : [];

  await step('Platform package manifests', () => checkManifests(release));
  await step('napi prepublish --dry-run', () => {
    runTool('napi', [
      'prepublish',
      '--tag-style',
      'npm',
      '--dry-run',
      '--no-gh-release',
      ...targetArgs,
    ]);
    console.log(`napi prepublish accepted ${targets.map((target) => target.abi).join(', ')}.`);
  });
  for (const target of targets) {
    await step(`npm pack ${relative(ROOT, target.packageDir)}`, () => checkPlatformPackage(target));
  }
  await step('Platform binary requirements', () => {
    for (const target of targets) {
      checkBinaryRequirements(target);
    }
  });

  const workDir = mkdtempSync(join(tmpdir(), 'comprs-pack-'));
  try {
    const tarball = await step('npm pack (root package)', () => checkRootPackage(release, workDir));
    if (tarball !== undefined) {
      await step('publint', () => runTool('publint', ['run', tarball]));
      await step('attw', () => runTool('attw', [tarball]));
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
  await step('Repository metadata', () => checkRepositoryUrls(release));

  if (problems.length > 0) {
    throw new Error(
      `The release dry run found ${problems.length} problem(s):\n${problems.join('\n')}`,
    );
  }
  console.log(`\nThe root package and ${targets.length} platform package(s) are ready to publish.`);
});

/**
 * Run one check in a log group. A problem it reports, or an error it throws,
 * fails the run at the end, after the other checks had their turn.
 *
 * @template T
 * @param {string} title
 * @param {() => T | Promise<T>} fn
 * @returns {Promise<T | undefined>}
 */
function step(title, fn) {
  return group(title, async () => {
    const before = problems.length;
    try {
      return await fn();
    } catch (error) {
      problems.push(`${title}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    } finally {
      for (const problem of problems.slice(before)) {
        console.log(`Problem: ${problem}`);
      }
    }
  });
}

/**
 * Pick the platform packages to check: all of them, or with `allowMissing`
 * the ones that prepare-release.mjs filled with a binary.
 *
 * @param {ReleaseTarget[]} targets
 * @param {boolean} allowMissing
 */
function selectTargets(targets, allowMissing) {
  const built = targets.filter((target) => existsSync(join(target.packageDir, target.artifact)));
  const missing = targets.filter((target) => !built.includes(target));
  if (missing.length === 0) {
    return targets;
  }
  const names = missing.map((target) => relative(ROOT, join(target.packageDir, target.artifact)));
  if (!allowMissing || built.length === 0) {
    throw new Error(
      `Missing ${names.join(', ')}; run scripts/prepare-release.mjs with the build artifacts first`,
    );
  }
  annotate(
    'notice',
    `Partial release dry run. Built: ${built.map((target) => target.abi).join(', ')}. ` +
      `Not built, so napi prepublish, npm pack and the binary checks skip them: ` +
      `${missing.map((target) => target.abi).join(', ')}. The root package is checked in full.`,
  );
  return built;
}

/**
 * Check that every platform package matches its napi target and the root
 * package's version, and that optionalDependencies agree.
 *
 * @param {Release} release
 */
function checkManifests(release) {
  for (const target of release.targets) {
    checkPlatformManifest(release, target);
  }
  for (const entry of readdirSync(join(ROOT, 'npm'), { withFileTypes: true })) {
    if (entry.isDirectory() && !release.targets.some((target) => target.abi === entry.name)) {
      problems.push(`npm/${entry.name} does not belong to any target in napi.targets`);
    }
  }
  const declared = release.packageJson['optionalDependencies'];
  const optionalDependencies = isRecord(declared) ? Object.entries(declared) : [];
  for (const [name, range] of optionalDependencies) {
    const managed = name.startsWith(`${release.packageName}-`);
    if (managed && !release.targets.some((target) => target.packageName === name)) {
      problems.push(`optionalDependencies lists ${name}, which no napi target publishes`);
    } else if (managed && range !== release.version) {
      problems.push(`optionalDependencies pins ${name} to ${range}, not ${release.version}`);
    }
  }
}

/**
 * @param {Release} release
 * @param {ReleaseTarget} target
 */
function checkPlatformManifest(release, target) {
  const manifestPath = join(target.packageDir, 'package.json');
  const shownPath = relative(ROOT, manifestPath);
  if (!existsSync(manifestPath)) {
    problems.push(`${shownPath} does not exist`);
    return;
  }
  const manifest = readJson(manifestPath);
  if (manifest['name'] !== target.packageName) {
    problems.push(`${shownPath} is named ${manifest['name']}, not ${target.packageName}`);
  }
  if (manifest['version'] !== release.version) {
    problems.push(
      `${shownPath} has version ${manifest['version']}, but the root package has ` +
        `${release.version}; run napi version`,
    );
  }
}

/**
 * Check that every package the release publishes names the root package's
 * GitHub repository. A platform package without a package.json is left to
 * checkManifests, which reports it.
 *
 * @param {Release} release
 */
function checkRepositoryUrls(release) {
  const platformManifests = release.targets
    .map((target) => join(target.packageDir, 'package.json'))
    .filter((path) => existsSync(path));
  const otherManifests = [...platformManifests, join(ROOT, 'packages/middleware/package.json')];
  const manifests = [
    { path: 'package.json', json: release.packageJson },
    ...otherManifests.map((path) => ({ path: relative(ROOT, path), json: readJson(path) })),
  ];
  problems.push(...repositoryUrlProblems(manifests));
  console.log(`Checked the repository URLs of ${manifests.map(({ path }) => path).join(', ')}.`);
}

/**
 * Check what `npm pack` would publish for a platform package.
 *
 * @param {ReleaseTarget} target
 */
function checkPlatformPackage(target) {
  const manifest = readJson(join(target.packageDir, 'package.json'));
  const { files: packed } = npmPack(target.packageDir, ['--dry-run']);
  const required = [
    'package.json',
    target.artifact,
    ...stringList(manifest['files']),
    ...[manifest['main'], manifest['types'], manifest['browser']].filter(
      (entry) => typeof entry === 'string',
    ),
  ];
  for (const file of new Set(required.map(normalizePath))) {
    if (!packed.includes(file)) {
      problems.push(`${target.packageName} would be published without ${file}`);
    }
  }
  console.log(packed.join('\n'));
}

/**
 * Check what a platform binary needs from the system at load time. Symbol
 * versions such as `GLIBC_2.17` and the names of imported DLLs are plain
 * strings in the binary, so a scan for them works for every target on any
 * host.
 *
 * @param {ReleaseTarget} target
 */
function checkBinaryRequirements(target) {
  const binary = relative(ROOT, join(target.packageDir, target.artifact));
  const contents = readFileSync(join(target.packageDir, target.artifact)).toString('latin1');
  const glibc = [...contents.matchAll(/\bGLIBC_(\d+)\.(\d+)/g)]
    .map(([, major, minor]) => ({ major: Number(major), minor: Number(minor) }))
    .sort(compareVersions);
  if (target.abi.endsWith('-gnu')) {
    const newest = glibc.at(-1);
    if (newest === undefined) {
      problems.push(`${binary} needs no versioned glibc symbol, so it is not a glibc build`);
    } else if (compareVersions(newest, MAX_GLIBC) > 0) {
      problems.push(
        `${binary} needs glibc ${formatVersion(newest)}, newer than ` +
          `${formatVersion(MAX_GLIBC)}; build it with napi-cross, as build.yml does`,
      );
    } else {
      console.log(`${binary} needs glibc ${formatVersion(newest)}.`);
    }
  } else if (target.abi.endsWith('-musl')) {
    if (glibc.length > 0) {
      problems.push(`${binary} needs versioned glibc symbols, so it is not a musl build`);
    } else {
      console.log(`${binary} needs no glibc.`);
    }
  } else if (target.abi.endsWith('-msvc')) {
    const dlls = [...new Set(contents.match(DYNAMIC_CRT_DLL) ?? [])];
    if (dlls.length > 0) {
      problems.push(
        `${binary} imports the dynamic C runtime (${dlls.join(', ')}), so it needs the ` +
          'Visual C++ Redistributable; link it with +crt-static in .cargo/config.toml',
      );
    } else {
      console.log(`${binary} imports no dynamic C runtime DLL.`);
    }
  }
}

/**
 * @param {GlibcVersion} a
 * @param {GlibcVersion} b
 */
function compareVersions(a, b) {
  return a.major - b.major || a.minor - b.minor;
}

/** @param {GlibcVersion} version */
function formatVersion({ major, minor }) {
  return `${major}.${minor}`;
}

/**
 * Pack the root package into `workDir`, check the tarball's contents and
 * return its path.
 *
 * @param {Release} release
 * @param {string} workDir
 * @returns {string}
 */
function checkRootPackage(release, workDir) {
  const { filename, files: packed } = npmPack(ROOT, ['--pack-destination', workDir]);
  console.log(packed.join('\n'));
  const tarball = join(workDir, filename);
  const contents = join(workDir, 'contents');
  mkdirSync(contents);
  run('tar', ['-xzf', tarball, '-C', contents]);

  checkRootFiles(release, packed);
  const { packageJson } = release;
  const browserEntries = exportTargets(packageJson['exports'], 'browser');
  if (typeof packageJson['browser'] === 'string') {
    browserEntries.push(packageJson['browser']);
  }
  const browserModules = browserEntries
    .map(normalizePath)
    .filter((file) => !/\.d\.[cm]?ts$/.test(file));
  problems.push(
    ...browserEntryProblems(join(contents, 'package'), packed, [...new Set(browserModules)]),
  );
  return tarball;
}

/**
 * Check that the root package holds every file and entry point its
 * package.json names, and no platform binary.
 *
 * @param {Release} release
 * @param {string[]} packed
 */
function checkRootFiles(release, packed) {
  const { packageJson } = release;
  for (const entry of stringList(packageJson['files'])) {
    const file = normalizePath(entry);
    if (/[*?[\]{}!]/.test(file)) {
      problems.push(
        `package.json files entry ${entry} is a pattern, which this check cannot verify`,
      );
    } else if (!packed.some((path) => path === file || path.startsWith(`${file}/`))) {
      problems.push(`The root package would be published without ${entry}`);
    }
  }
  const entryPoints = [
    packageJson['main'],
    packageJson['module'],
    packageJson['browser'],
    packageJson['types'],
  ]
    .filter((entry) => typeof entry === 'string')
    .concat(exportTargets(packageJson['exports']));
  for (const file of new Set(entryPoints.map(normalizePath))) {
    if (!file.includes('*') && !packed.includes(file)) {
      problems.push(`The root package entry point ${file} would not be published`);
    }
  }
  const binaryName = release.binaryName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const binary = new RegExp(`(^|/)${binaryName}\\.[^/]+\\.(node|wasm)$`);
  for (const file of packed.filter((path) => binary.test(path))) {
    problems.push(`The root package would ship the platform binary ${file}`);
  }
}

/**
 * Collect the file paths of an `exports` field: all of them, or those under
 * the given condition.
 *
 * @param {unknown} value `exports`, or a value inside it.
 * @param {string} [condition]
 * @param {boolean} [matched] Whether `value` is under `condition` already.
 * @returns {string[]}
 */
function exportTargets(value, condition, matched = condition === undefined) {
  if (typeof value === 'string') {
    return matched ? [value] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => exportTargets(item, condition, matched));
  }
  if (!isRecord(value)) {
    return [];
  }
  return Object.entries(value).flatMap(([key, item]) =>
    exportTargets(item, condition, matched || key === condition),
  );
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function stringList(value) {
  /** @type {unknown[]} */
  const entries = Array.isArray(value) ? value : [];
  return entries.filter((entry) => typeof entry === 'string');
}
