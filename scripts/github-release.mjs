#!/usr/bin/env node

/**
 * Stage the GitHub release of a version: the files to attach to it, and its
 * notes.
 *
 * The `publish` job of .github/workflows/release.yml runs this after
 * prepare-release.mjs has assembled the npm packages, and uploads the staged
 * directory as an artifact. The `github-release` job then creates the release
 * `v<version>` on the published commit from that artifact with gh alone: it
 * holds `contents: write`, so it runs none of the repository's code. The
 * `release-dry-run` job of .github/workflows/ci.yml runs this with --dry-run
 * on every CI run, so that a target without its binary or its license
 * notices, or two files with the same asset name, fail a pull request rather
 * than the release.
 *
 * The release gets (releaseAssets()):
 *
 *   - LICENSE, comprs's own license;
 *   - each platform package's binary, `<binaryName>.<abi>.node`, under the
 *     name that `napi prepublish` gave it when it created the releases;
 *   - next to each binary, its package's THIRD_PARTY_LICENSES as
 *     `THIRD_PARTY_LICENSES.<abi>.txt`: the license notices of the
 *     third-party code that the binary links statically, which most of their
 *     licenses require to accompany it (#709). The names of a release's
 *     assets must differ, hence the target in the name.
 *
 * The notes are the section of CHANGELOG.md for the version
 * (changelogSection()), or a link to CHANGELOG.md when it has none, followed
 * by a description of the assets (releaseNotes()).
 *
 * Usage:
 *   node scripts/github-release.mjs (--out-dir <dir> | --dry-run) [--allow-missing-targets]
 *
 *   --out-dir                Directory to stage the release in, which must be
 *                            empty or not exist: the files to attach go to
 *                            <dir>/assets under their asset names, and the
 *                            notes to <dir>/notes.md.
 *   --dry-run                Check the files and print them and the notes,
 *                            without writing anything.
 *   --allow-missing-targets  Leave out the targets whose binary was not built,
 *                            for CI runs that build some targets. Without it,
 *                            a missing binary is an error.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  annotate,
  group,
  isEntryPoint,
  ROOT,
  readRelease,
  repositoryUrl,
  runMain,
} from './release-utils.mjs';
import { NOTICE_FILE } from './third-party-licenses.mjs';

/** @typedef {import('./release-utils.mjs').ReleaseTarget} ReleaseTarget */

/**
 * A file to attach to the GitHub release.
 *
 * @typedef {object} ReleaseAsset
 * @property {string} name Its name in the release.
 * @property {string} source Path of the file.
 */

/** comprs's own license, at the root of the repository. */
const LICENSE_FILE = 'LICENSE';

/**
 * Asset names that GitHub keeps as they are: it replaces other characters,
 * and a period at either end, in the names of uploaded assets.
 */
const ASSET_NAME = /^[\w-](?:[\w.-]*[\w-])?$/;

/**
 * The files to attach to the release of the given targets: LICENSE once, and
 * each target's binary and license notices, from its npm package.
 *
 * @param {ReleaseTarget[]} targets
 * @param {string} [root] Directory of the root package, which holds LICENSE.
 * @returns {ReleaseAsset[]}
 */
export function releaseAssets(targets, root = ROOT) {
  return [
    { name: LICENSE_FILE, source: join(root, LICENSE_FILE) },
    ...targets.flatMap((target) => [
      { name: target.artifact, source: join(target.packageDir, target.artifact) },
      {
        name: `${NOTICE_FILE}.${target.abi}.txt`,
        source: join(target.packageDir, NOTICE_FILE),
      },
    ]),
  ];
}

/**
 * Check the names of the assets: GitHub must keep each one as it is, and no
 * two may be the same, even in another case, which file systems that ignore
 * case would not tell apart once downloaded.
 *
 * @param {ReleaseAsset[]} assets
 * @returns {string[]} A problem for each name that GitHub would change, and
 *   for each asset whose name an earlier one has.
 */
export function assetNameProblems(assets) {
  /** @type {string[]} */
  const problems = [];
  /** @type {Map<string, string>} */
  const names = new Map();
  for (const { name } of assets) {
    if (!ASSET_NAME.test(name)) {
      problems.push(
        `The asset name "${name}" has characters that GitHub replaces; use letters, digits, ` +
          '"-", "_" and ".", but no "." at either end',
      );
    }
    const earlier = names.get(name.toLowerCase());
    if (earlier === undefined) {
      names.set(name.toLowerCase(), name);
    } else if (earlier === name) {
      problems.push(`Two assets are named ${name}`);
    } else {
      problems.push(`Two assets are named ${name} and ${earlier}, which differ only in case`);
    }
  }
  return problems;
}

/**
 * Check that the file of each asset exists.
 *
 * @param {ReleaseAsset[]} assets
 * @returns {string[]} A problem for each file that is missing or not a file.
 */
export function assetFileProblems(assets) {
  return assets.flatMap(({ name, source }) => {
    if (!existsSync(source)) {
      return [`${name}: ${source} does not exist`];
    }
    return statSync(source).isFile() ? [] : [`${name}: ${source} is not a file`];
  });
}

/**
 * Return the section of a changelog for a version: the lines below its
 * `## <version>` heading, as changesets writes it, up to the next heading of
 * level 1 or 2, without the blank lines at either end. Only a heading at the
 * start of a line counts: changesets indents every line of an entry after
 * its first, so a heading in the text of a changeset, such as a migration
 * guide's `## Migration`, does not end the section. Lines in fenced code
 * blocks are not headings either.
 *
 * @param {string} changelog
 * @param {string} version
 * @returns {string | undefined} undefined when the changelog has no section
 *   for the version, or an empty one.
 */
export function changelogSection(changelog, version) {
  /** @type {string[] | undefined} */
  let section;
  for (const { line, heading } of markdownLines(changelog)) {
    if (section === undefined) {
      if (heading?.level === 2 && heading.title === version) {
        section = [];
      }
    } else if (heading !== undefined && heading.level <= 2) {
      break;
    } else {
      section.push(line);
    }
  }
  const text = (section ?? [])
    .join('\n')
    .replace(/^(?:[ \t]*\n)+/, '')
    .trimEnd();
  return text === '' ? undefined : text;
}

/**
 * A line of a Markdown text, and the ATX heading that it is, if it is one at
 * the start of the line and outside a fenced code block.
 *
 * @typedef {object} MarkdownLine
 * @property {string} line
 * @property {{ level: number, title: string } | undefined} heading
 */

/**
 * Yield the lines of a Markdown text.
 *
 * @param {string} text
 * @returns {Generator<MarkdownLine>}
 */
function* markdownLines(text) {
  // The marker of the fenced code block that the lines are in.
  /** @type {string | undefined} */
  let fence;
  for (const line of text.split(/\r?\n/)) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence !== undefined) {
      if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length) {
        fence = undefined;
      }
      yield { line, heading: undefined };
      continue;
    }
    fence = marker;
    const match = /^(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/.exec(line);
    const hashes = match?.[1];
    yield {
      line,
      heading: hashes === undefined ? undefined : { level: hashes.length, title: match?.[2] ?? '' },
    };
  }
}

/**
 * Write the notes of a release: the changelog section of its version, or a
 * link to the changelog without one, then what its assets are.
 *
 * @param {object} notes
 * @param {string | undefined} notes.section The changelog section.
 * @param {string} notes.changelogUrl
 * @param {string} notes.binaryName Base name of the binaries.
 * @param {string} notes.packageName Name of the root package.
 * @returns {string}
 */
export function releaseNotes({ section, changelogUrl, binaryName, packageName }) {
  const changes = section ?? `See [CHANGELOG.md](${changelogUrl}) for the changes in this version.`;
  return [
    changes,
    '',
    '### Release assets',
    '',
    `Each \`${binaryName}.<abi>.node\` is the native addon of the npm package ` +
      `\`${packageName}-<abi>\`. \`${NOTICE_FILE}.<abi>.txt\` holds the license notices of ` +
      'the third-party code that it links statically, and ' +
      `\`${LICENSE_FILE}\` is the license of \`${packageName}\`.`,
    '',
  ].join('\n');
}

/**
 * Pick the targets to attach: all of them, or with `allowMissing` the ones
 * whose binary prepare-release.mjs put into their npm package.
 *
 * @param {ReleaseTarget[]} targets
 * @param {boolean} allowMissing
 * @returns {ReleaseTarget[]}
 */
function selectTargets(targets, allowMissing) {
  const built = targets.filter((target) => existsSync(join(target.packageDir, target.artifact)));
  if (!allowMissing || built.length === targets.length) {
    return targets;
  }
  if (built.length === 0) {
    throw new Error(
      'No platform package holds its binary; run scripts/prepare-release.mjs with the build ' +
        'artifacts first',
    );
  }
  const missing = targets.filter((target) => !built.includes(target));
  annotate(
    'notice',
    `Partial GitHub release. Not built, so left out: ${missing.map((target) => target.abi).join(', ')}`,
  );
  return built;
}

/**
 * Copy the assets to `<outDir>/assets` under their names, and write the
 * notes to `<outDir>/notes.md`.
 *
 * @param {string} outDir
 * @param {ReleaseAsset[]} assets
 * @param {string} notes
 */
function stage(outDir, assets, notes) {
  const assetsDir = join(outDir, 'assets');
  mkdirSync(assetsDir, { recursive: true });
  for (const { name, source } of assets) {
    copyFileSync(source, join(assetsDir, name));
  }
  writeFileSync(join(outDir, 'notes.md'), notes);
  console.log(`Staged the release in ${outDir}.`);
}

if (isEntryPoint(import.meta.filename)) {
  await runMain(async () => {
    const { values } = parseArgs({
      options: {
        'out-dir': { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        'allow-missing-targets': { type: 'boolean', default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    if ((values['out-dir'] === undefined) !== values['dry-run']) {
      throw new Error(
        'Usage: node scripts/github-release.mjs (--out-dir <dir> | --dry-run) ' +
          '[--allow-missing-targets]',
      );
    }
    const outDir = values['out-dir'] === undefined ? undefined : resolve(values['out-dir']);
    if (outDir !== undefined && existsSync(outDir) && readdirSync(outDir).length > 0) {
      throw new Error(`${outDir} is not empty`);
    }
    const release = await readRelease();
    const tag = `v${release.version}`;
    // The names of every target, built or not, must be fit for the release.
    const problems = assetNameProblems(releaseAssets(release.targets));
    const assets = releaseAssets(selectTargets(release.targets, values['allow-missing-targets']));
    problems.push(...assetFileProblems(assets));
    if (problems.length > 0) {
      throw new Error(`The release ${tag} cannot be staged:\n${problems.join('\n')}`);
    }

    const repository = repositoryUrl(release.packageJson);
    if (repository === undefined) {
      throw new Error('package.json names no repository, whose CHANGELOG.md the notes link to');
    }
    const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
    const section = changelogSection(changelog, release.version);
    if (section === undefined) {
      annotate(
        'warning',
        `CHANGELOG.md has no section for ${release.version}; the notes of ${tag} link to it instead`,
      );
    }
    const notes = releaseNotes({
      section,
      changelogUrl: `${repository}/blob/${tag}/CHANGELOG.md`,
      binaryName: release.binaryName,
      packageName: release.packageName,
    });

    console.log(
      `The GitHub release ${tag} of ${release.packageName} gets ${assets.length} assets:`,
    );
    for (const { name, source } of assets) {
      console.log(`  ${name} (${statSync(source).size} bytes, from ${relative(ROOT, source)})`);
    }
    await group(`Notes of ${tag}`, () => console.log(notes));
    if (outDir !== undefined) {
      stage(outDir, assets, notes);
    }
  });
}
