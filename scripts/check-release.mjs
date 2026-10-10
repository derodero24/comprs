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
 *   6. publint and attw accept that tarball.
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
import { join, matchesGlob, posix, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { parseAst } from 'vite';
import {
  annotate,
  group,
  isRecord,
  napiTargetArgs,
  npmPack,
  ROOT,
  readJson,
  readRelease,
  run,
  runMain,
  runTool,
} from './release-utils.mjs';

/** @typedef {import('./release-utils.mjs').Release} Release */
/** @typedef {import('./release-utils.mjs').ReleaseTarget} ReleaseTarget */
/** @typedef {{ major: number, minor: number }} GlibcVersion */

/** ESTree nodes whose `source` names a module that the module loads. */
const MODULE_NODE_TYPES = new Set([
  'ImportDeclaration',
  'ImportExpression',
  'ExportAllDeclaration',
  'ExportNamedDeclaration',
]);

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
  checkBrowserEntry(join(contents, 'package'), packed, [...new Set(browserModules)]);
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
 * Follow every module that each browser entry point loads and check that
 * each one is a file of the package. A bare specifier fails: the browser
 * build must not depend on another package (2.0.2's browser.js imported the
 * WASI package, which is not even installed), nor on Node.js. Each entry
 * point must reach a WebAssembly module, through `new URL()`: esbuild cannot
 * bundle a .wasm file that is imported as an ES module. Bundlers must parse
 * every module as an ES module, which also keeps the CommonJS loaders of the
 * native addon out, and keep the entry points, which initialise the
 * WebAssembly module, when they tree-shake.
 *
 * @param {string} packageDir Extracted package.
 * @param {string[]} packed Files in the package.
 * @param {string[]} entries Browser entry points.
 */
function checkBrowserEntry(packageDir, packed, entries) {
  if (entries.length === 0) {
    problems.push('package.json declares no browser entry point');
    return;
  }
  /**
   * The package files that each module loads, checked once per module.
   *
   * @type {Map<string, string[]>}
   */
  const dependencies = new Map();
  const dependenciesOf = (/** @type {string} */ file) => {
    let found = dependencies.get(file);
    if (found === undefined) {
      if (packed.includes(file)) {
        found = checkBrowserModule(packageDir, file);
      } else {
        problems.push(`The browser entry loads ${file}, which the package does not include`);
        found = [];
      }
      dependencies.set(file, found);
    }
    return found;
  };
  for (const entry of entries) {
    checkEntrySideEffects(packageDir, entry);
    const seen = new Set([entry]);
    for (const file of seen) {
      for (const dependency of dependenciesOf(file)) {
        seen.add(dependency);
      }
    }
    console.log(`Browser entry ${entry} loads: ${[...seen].slice(1).join(', ')}`);
    if (![...seen].some((file) => file.endsWith('.wasm') && packed.includes(file))) {
      problems.push(
        `The browser entry ${entry} does not load a WebAssembly module from the package`,
      );
    }
  }
}

/**
 * Check that a JavaScript file that the browser entry loads is an ES module
 * and loads WebAssembly through `new URL()`, and return the package files it
 * loads. Return nothing for other files.
 *
 * @param {string} packageDir Extracted package.
 * @param {string} file Path relative to `packageDir`.
 * @returns {string[]}
 */
function checkBrowserModule(packageDir, file) {
  if (!/\.[cm]?js$/.test(file)) {
    return [];
  }
  if (!isEsModule(packageDir, file)) {
    problems.push(
      `The browser entry module ${file} is not an ES module by its file extension or the ` +
        '"type" of its nearest package.json, so bundlers do not parse its import and export ' +
        'statements',
    );
  }
  const dependencies = localDependencies(packageDir, file);
  for (const { path } of dependencies.filter(({ path, url }) => path.endsWith('.wasm') && !url)) {
    problems.push(
      `The browser entry module ${file} imports ${path} as an ES module, which needs ` +
        "WebAssembly ESM integration; load it through new URL('…', import.meta.url)",
    );
  }
  return dependencies.map(({ path }) => path);
}

/**
 * Check that no `sideEffects` field lets bundlers drop a browser entry point.
 * Vite reads the field of the package root for the entry point it resolves,
 * webpack that of the package.json nearest to the file.
 *
 * @param {string} packageDir Extracted package.
 * @param {string} entry Path relative to `packageDir`.
 */
function checkEntrySideEffects(packageDir, entry) {
  const manifests = [{ dir: '.', manifest: readJson(join(packageDir, 'package.json')) }];
  const nearest = nearestManifest(packageDir, entry);
  if (nearest.dir !== '.') {
    manifests.push(nearest);
  }
  for (const { dir, manifest } of manifests) {
    if (!hasSideEffects(manifest['sideEffects'], posix.relative(dir, entry))) {
      problems.push(
        `${posix.join(dir, 'package.json')} marks the browser entry ${entry} as side-effect ` +
          'free, so bundlers may drop the initialisation of the WebAssembly module',
      );
    }
  }
}

/**
 * Whether a `sideEffects` field marks a file as having side effects, as
 * webpack and Vite read it: a pattern without a `/` matches the file name in
 * any directory.
 *
 * @param {unknown} sideEffects
 * @param {string} file Path relative to the directory of the package.json.
 */
function hasSideEffects(sideEffects, file) {
  if (!Array.isArray(sideEffects)) {
    return sideEffects !== false;
  }
  /** @type {unknown[]} */
  const patterns = sideEffects;
  return patterns.some((pattern) => {
    if (typeof pattern !== 'string') {
      return false;
    }
    const glob = normalizePath(pattern);
    return matchesGlob(file, glob.includes('/') ? glob : `**/${glob}`);
  });
}

/**
 * Whether bundlers and Node parse a JavaScript file of the package as an ES
 * module.
 *
 * @param {string} packageDir Extracted package.
 * @param {string} file Path relative to `packageDir`.
 */
function isEsModule(packageDir, file) {
  if (file.endsWith('.mjs') || file.endsWith('.cjs')) {
    return file.endsWith('.mjs');
  }
  return nearestManifest(packageDir, file).manifest['type'] === 'module';
}

/**
 * Return the package.json that applies to a file of the package, the
 * nearest one, with its directory relative to the package.
 *
 * @param {string} packageDir Extracted package.
 * @param {string} file Path relative to `packageDir`.
 * @returns {{ dir: string, manifest: Record<string, unknown> }}
 */
function nearestManifest(packageDir, file) {
  let dir = posix.dirname(file);
  while (dir !== '.' && !existsSync(join(packageDir, dir, 'package.json'))) {
    dir = posix.dirname(dir);
  }
  return { dir, manifest: readJson(join(packageDir, dir, 'package.json')) };
}

/**
 * Return the package files that a JavaScript file of the package loads, and
 * whether it loads each one through `new URL()`, and report every module it
 * imports from elsewhere.
 *
 * @param {string} packageDir
 * @param {string} file Path relative to `packageDir`.
 * @returns {{ path: string, url: boolean }[]}
 */
function localDependencies(packageDir, file) {
  const ast = parseAst(readFileSync(join(packageDir, file), 'utf8'));
  /** @type {{ path: string, url: boolean }[]} */
  const dependencies = [];
  for (const { specifier, url } of moduleReferences(ast)) {
    const local = url
      ? !/^[a-z][a-z\d+.-]*:|^\//i.test(specifier)
      : specifier.startsWith('./') || specifier.startsWith('../');
    if (local) {
      dependencies.push({ path: posix.normalize(posix.join(posix.dirname(file), specifier)), url });
    } else {
      problems.push(
        `The browser entry module ${file} imports ${specifier}, which is not part of the package`,
      );
    }
  }
  return dependencies;
}

/**
 * Yield the modules and assets an ES module loads: static and dynamic
 * imports, re-exports, and `new URL('…', import.meta.url)` references (the
 * way wasm-bindgen's `web` target locates its .wasm file).
 *
 * @param {unknown} node ESTree node, or an array or value inside one.
 * @returns {Generator<{ specifier: string, url: boolean }>}
 */
function* moduleReferences(node) {
  if (Array.isArray(node)) {
    for (const child of node) {
      yield* moduleReferences(child);
    }
    return;
  }
  if (!isRecord(node)) {
    return;
  }
  const source = stringLiteral(node['source']);
  if (source !== undefined && MODULE_NODE_TYPES.has(String(node['type']))) {
    yield { specifier: source, url: false };
  }
  const url = importMetaUrl(node);
  if (url !== undefined) {
    yield { specifier: url, url: true };
  }
  for (const value of Object.values(node)) {
    yield* moduleReferences(value);
  }
}

/**
 * Return the path of a `new URL('<path>', import.meta.url)` expression.
 *
 * @param {Record<string, unknown>} node
 * @returns {string | undefined}
 */
function importMetaUrl(node) {
  const { callee } = node;
  if (node['type'] !== 'NewExpression' || !isRecord(callee) || callee['name'] !== 'URL') {
    return undefined;
  }
  /** @type {unknown[]} */
  const args = Array.isArray(node['arguments']) ? node['arguments'] : [];
  const [path, base] = args;
  const isImportMetaUrl =
    isRecord(base) &&
    base['type'] === 'MemberExpression' &&
    isRecord(base['object']) &&
    base['object']['type'] === 'MetaProperty' &&
    isRecord(base['property']) &&
    base['property']['name'] === 'url';
  return isImportMetaUrl ? stringLiteral(path) : undefined;
}

/**
 * @param {unknown} node
 * @returns {string | undefined}
 */
function stringLiteral(node) {
  if (!isRecord(node) || node['type'] !== 'Literal') {
    return undefined;
  }
  const { value } = node;
  return typeof value === 'string' ? value : undefined;
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

/**
 * Turn a package.json path such as `./index.js` into a packed path.
 *
 * @param {string} path
 */
function normalizePath(path) {
  return posix.normalize(path.replaceAll('\\', '/')).replace(/^\.\//, '');
}
