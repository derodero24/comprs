#!/usr/bin/env node

/**
 * Assemble the npm packages from the build artifacts, exactly as the release
 * publishes them.
 *
 * The `publish` job of .github/workflows/release.yml runs this before
 * `npm publish`, and the `release-dry-run` job of .github/workflows/ci.yml
 * runs it on every CI run, so packaging problems show up in pull requests
 * instead of during a release. It expects the `bindings-*` artifacts of the
 * build jobs under --artifacts-dir, one directory per artifact, as
 * actions/download-artifact lays them out. Then it:
 *
 *   1. copies the wasm-bindgen browser build (`bindings-wasm-bindgen`) to
 *      browser/, next to the browser entry of the root package that loads it;
 *   2. runs `napi artifacts`, which copies every native binary into its
 *      npm/<platform> package;
 *   3. restores every file of the root package that `napi artifacts`
 *      rewrote: the root package ships its files as committed, plus the
 *      wasm-bindgen build. `napi artifacts` copies the index.js of a build
 *      artifact over the committed one, and while a WASI target was
 *      configured, it also regenerated the browser.js that the browser entry
 *      of 2.0.2 loaded, to re-export the WASI package (#564);
 *   4. checks that every file the root and platform packages list exists:
 *      npm publish leaves out a missing `files` entry without an error.
 *
 * Usage:
 *   node scripts/prepare-release.mjs [--artifacts-dir <dir>] [--allow-missing-targets]
 *
 *   --artifacts-dir          Directory holding the downloaded artifacts
 *                            (default: artifacts).
 *   --allow-missing-targets  Assemble only the platform packages whose binary
 *                            was built, for CI runs that build some targets.
 *                            Without it, a missing binary is an error.
 */

import {
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { napiTargetArgs, ROOT, readJson, readRelease, runMain, runTool } from './release-utils.mjs';

/** Artifact that holds the wasm-bindgen build (see the build-wasm-bindgen jobs). */
const WASM_BINDGEN_ARTIFACT = 'bindings-wasm-bindgen';

/** Directory of the root package's browser entry and the wasm-bindgen build. */
const BROWSER_DIR = join(ROOT, 'browser');

await runMain(async () => {
  const { values } = parseArgs({
    options: {
      'artifacts-dir': { type: 'string', default: 'artifacts' },
      'allow-missing-targets': { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  const artifactsDir = resolve(values['artifacts-dir']);
  if (!existsSync(artifactsDir) || !statSync(artifactsDir).isDirectory()) {
    throw new Error(`Artifacts directory ${artifactsDir} does not exist`);
  }

  const release = await readRelease();
  const targets = selectTargets(release.targets, artifactsDir, values['allow-missing-targets']);

  copyWasmBindgenBuild(artifactsDir);

  const rootFiles = packageFiles(release.packageJson, ROOT, 'package.json');
  const snapshot = new Map(rootFiles.map((file) => [file, readFileSync(join(ROOT, file))]));
  const targetArgs = targets.length < release.targets.length ? napiTargetArgs(targets) : [];
  runTool('napi', ['artifacts', '--output-dir', artifactsDir, ...targetArgs]);
  restoreRootFiles(snapshot);

  for (const target of targets) {
    const manifest = readJson(join(target.packageDir, 'package.json'));
    packageFiles(
      manifest,
      target.packageDir,
      relative(ROOT, join(target.packageDir, 'package.json')),
    );
    listPackage(target.packageDir);
  }
  console.log(`Assembled ${targets.length} platform package(s) and the root package.`);
});

/**
 * Pick the targets to assemble: every configured target, or with
 * `allowMissing` the ones whose binary is among the artifacts.
 *
 * @param {import('./release-utils.mjs').ReleaseTarget[]} targets
 * @param {string} artifactsDir
 * @param {boolean} allowMissing
 */
function selectTargets(targets, artifactsDir, allowMissing) {
  const found = new Set(listFiles(artifactsDir).map((file) => file.split('/').pop()));
  const missing = targets.filter((target) => !found.has(target.artifact));
  if (missing.length === 0) {
    return targets;
  }
  const names = missing.map((target) => `${target.triple} (${target.artifact})`).join(', ');
  if (!allowMissing) {
    throw new Error(`No build artifact in ${artifactsDir} for ${names}`);
  }
  const present = targets.filter((target) => found.has(target.artifact));
  if (present.length === 0) {
    throw new Error(`No build artifact in ${artifactsDir} for any napi target`);
  }
  console.log(`Skipping the targets that were not built: ${names}`);
  return present;
}

/**
 * Copy the wasm-bindgen build to browser/, where the browser entry loads it.
 *
 * @param {string} artifactsDir
 */
function copyWasmBindgenBuild(artifactsDir) {
  const dir = join(artifactsDir, WASM_BINDGEN_ARTIFACT);
  const files = existsSync(dir)
    ? readdirSync(dir).filter((file) => file.startsWith('comprs-wasm'))
    : [];
  if (files.length === 0) {
    throw new Error(`No wasm-bindgen files in ${dir}; the browser build is missing`);
  }
  for (const file of files) {
    const dest = join(BROWSER_DIR, file);
    copyFileSync(join(dir, file), dest);
    console.log(`Copied ${relative(ROOT, join(dir, file))} to ${relative(ROOT, dest)}`);
  }
}

/**
 * Return every file a package's `files` field publishes, relative to the
 * package directory, and fail if an entry does not exist.
 *
 * @param {Record<string, unknown>} manifest
 * @param {string} packageDir
 * @param {string} manifestPath Shown in errors.
 * @returns {string[]}
 */
function packageFiles(manifest, packageDir, manifestPath) {
  const entries = manifest.files;
  if (!Array.isArray(entries) || !entries.every((entry) => typeof entry === 'string')) {
    throw new Error(`${manifestPath} has no files list`);
  }
  const missing = entries.filter((entry) => !existsSync(join(packageDir, entry)));
  if (missing.length > 0) {
    throw new Error(`Missing files listed in ${manifestPath}: ${missing.join(', ')}`);
  }
  return entries.flatMap((entry) =>
    statSync(join(packageDir, entry)).isDirectory()
      ? listFiles(join(packageDir, entry)).map((file) => `${entry}/${file}`)
      : [entry],
  );
}

/**
 * Put back every root package file that `napi artifacts` changed or removed.
 *
 * @param {Map<string, Buffer>} snapshot File contents by path relative to the root.
 */
function restoreRootFiles(snapshot) {
  for (const [file, content] of snapshot) {
    const path = join(ROOT, file);
    if (existsSync(path) && readFileSync(path).equals(content)) {
      continue;
    }
    writeFileSync(path, content);
    console.log(`Restored ${file}, which napi artifacts had rewritten`);
  }
}

/**
 * Print a package directory's files and sizes.
 *
 * @param {string} packageDir
 */
function listPackage(packageDir) {
  console.log(`${relative(ROOT, packageDir)}/`);
  for (const file of listFiles(packageDir)) {
    console.log(`  ${file} (${statSync(join(packageDir, file)).size} bytes)`);
  }
}

/**
 * List the files below a directory, recursively, as `/`-separated paths
 * relative to it.
 *
 * @param {string} dir
 * @returns {string[]}
 */
function listFiles(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).replaceAll('\\', '/'))
    .sort();
}
