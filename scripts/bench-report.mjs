#!/usr/bin/env node

/**
 * Regenerate the benchmark tables of README.md, between `<!-- bench:start -->`
 * and `<!-- bench:end -->`, and the charts .github/assets/bench-compress.svg
 * and .github/assets/bench-cross-algorithm.svg, from one run of the
 * comparison benchmarks (__test__/*.compare.bench.ts). The tables give the
 * compression and decompression speeds in MB/s and the compression ratio of
 * each library on each input, and say what ran where: the versions, the
 * commit, the machine, the date and the settings.
 *
 * The README publishes only numbers from the Bench Report workflow
 * (.github/workflows/bench-report.yml), which runs this script on a
 * GitHub-hosted runner; see "Regenerating the README benchmarks" in
 * CONTRIBUTING.md. A local run checks the output: with BENCH_SMOKE=1, every
 * benchmark runs once, and the whole run takes under a minute. Revert its
 * changes afterwards (`git checkout README.md .github/assets`). CI runs it
 * this way in its benchmark smoke test, so that a change to Vitest's JSON
 * report or to the recorded sizes fails CI, not the next Bench Report run.
 *
 * Usage:
 *   node scripts/bench-report.mjs [--raw-dir <dir>]
 *
 *   --raw-dir <dir>  Keep the raw results in <dir>: Vitest's JSON report,
 *                    vitest.json, and the input and output sizes, sizes.json.
 *
 * Needs the native addon (`pnpm run build`; the release build, for numbers
 * that mean something).
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { cpus, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  COMPRESS_CHART,
  CROSS_ALGORITHM_CHART,
  collectReport,
  parseSizes,
  parseVitestReport,
  renderCompressChart,
  renderCrossAlgorithmChart,
  renderMarkdown,
  replaceSection,
} from './bench-render.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const README = join(ROOT, 'README.md');
const BENCH_FILES = ['algorithms', 'gzip', 'deflate', 'brotli', 'zstd', 'streaming'].map(
  (name) => `__test__/${name}.compare.bench.ts`,
);
/** The other libraries in the comparisons, whose versions the README names. */
const LIBRARIES = ['pako', 'fflate'];

const require = createRequire(import.meta.url);

/**
 * Parse a JSON file.
 *
 * @param {string} path
 * @returns {unknown}
 */
function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * The version in a package.json.
 *
 * @param {string} path
 * @returns {string}
 */
function packageVersion(path) {
  const json = readJson(path);
  const version =
    typeof json === 'object' && json !== null && 'version' in json ? json.version : undefined;
  if (typeof version !== 'string') {
    throw new Error(`${path} has no version`);
  }
  return version;
}

/**
 * The GitHub Actions runner, when the script runs in GitHub Actions.
 *
 * @returns {string | undefined}
 */
function describeRunner() {
  const { ImageOS: image, ImageVersion: imageVersion } = process.env;
  const details = [image, imageVersion === undefined ? undefined : `image ${imageVersion}`].filter(
    (detail) => detail !== undefined,
  );
  const kind =
    process.env['RUNNER_ENVIRONMENT'] === 'github-hosted' ? 'GitHub-hosted' : 'self-hosted';
  return `a ${kind} runner${details.length === 0 ? '' : ` (${details.join(', ')})`}`;
}

/**
 * Where and how the benchmarks run.
 *
 * @returns {import('./bench-render.mjs').Method}
 */
function describeMachine() {
  const [cpu] = cpus();
  const inGitHubActions = process.env['GITHUB_ACTIONS'] === 'true';
  const {
    GITHUB_SERVER_URL: server,
    GITHUB_REPOSITORY: repository,
    GITHUB_RUN_ID: runId,
  } = process.env;
  return {
    date: new Date().toISOString().slice(0, 10),
    version: packageVersion(join(ROOT, 'package.json')),
    commit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim(),
    node: process.version,
    cpu: cpu?.model.trim() ?? 'unknown CPU',
    cpuCount: cpus().length,
    platform: `${process.platform}/${process.arch}`,
    libraries: Object.fromEntries(
      LIBRARIES.map((name) => [name, packageVersion(require.resolve(`${name}/package.json`))]),
    ),
    runUrl: inGitHubActions ? `${server}/${repository}/actions/runs/${runId}` : undefined,
    runner: inGitHubActions ? describeRunner() : undefined,
    smoke: process.env['BENCH_SMOKE'] === '1',
  };
}

/**
 * Run the comparison benchmarks with Vitest, writing its JSON report to
 * `reportFile` and the sizes to `sizesFile`.
 *
 * @param {string} reportFile
 * @param {string} sizesFile
 */
function runBenchmarks(reportFile, sizesFile) {
  // recordSizes merges into an existing file.
  rmSync(sizesFile, { force: true });
  const vitest = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
  const { status, error } = spawnSync(
    process.execPath,
    [
      vitest,
      'bench',
      '--run',
      '--reporter=default',
      '--reporter=json',
      `--outputFile.json=${reportFile}`,
      ...BENCH_FILES,
    ],
    { cwd: ROOT, stdio: 'inherit', env: { ...process.env, COMPRS_BENCH_SIZES: sizesFile } },
  );
  if (error !== undefined) {
    throw error;
  }
  if (status !== 0) {
    throw new Error(`the benchmarks failed (exit code ${status})`);
  }
}

const { values } = parseArgs({ options: { 'raw-dir': { type: 'string' } } });

// Fail before the benchmarks run, not after, when the markers are missing.
replaceSection(readFileSync(README, 'utf8'), '');

// CI runs the comparisons through this script alone, so a comparison that
// BENCH_FILES leaves out would run nowhere, and be missing from the README.
const unlisted = readdirSync(join(ROOT, '__test__'))
  .filter((file) => file.endsWith('.compare.bench.ts'))
  .map((file) => `__test__/${file}`)
  .filter((file) => !BENCH_FILES.includes(file));
if (unlisted.length > 0) {
  throw new Error(`BENCH_FILES in scripts/bench-report.mjs leaves out ${unlisted.join(', ')}`);
}

const keepRaw = values['raw-dir'] !== undefined;
const rawDir =
  values['raw-dir'] === undefined
    ? mkdtempSync(join(tmpdir(), 'comprs-bench-report-'))
    : resolve(values['raw-dir']);

try {
  mkdirSync(rawDir, { recursive: true });
  const reportFile = join(rawDir, 'vitest.json');
  const sizesFile = join(rawDir, 'sizes.json');
  runBenchmarks(reportFile, sizesFile);

  const report = collectReport(
    parseVitestReport(readJson(reportFile)),
    parseSizes(readJson(sizesFile)),
  );
  const method = describeMachine();
  writeFileSync(
    README,
    replaceSection(readFileSync(README, 'utf8'), renderMarkdown(report, method)),
  );
  writeFileSync(join(ROOT, COMPRESS_CHART), renderCompressChart(report, method));
  writeFileSync(join(ROOT, CROSS_ALGORITHM_CHART), renderCrossAlgorithmChart(report, method));
  console.log(`Updated README.md, ${COMPRESS_CHART} and ${CROSS_ALGORITHM_CHART}.`);
  if (keepRaw) {
    console.log(`Raw results: ${rawDir}`);
  }
} finally {
  if (!keepRaw) {
    rmSync(rawDir, { recursive: true, force: true });
  }
}
