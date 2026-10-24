import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, resolve } from 'node:path';
import { build, type Plugin } from 'esbuild';
import { describe, expect, it } from 'vitest';

// packages/comprs publishes the library under the unscoped name `comprs`
// (#752): every entry point re-exports the one of @derodero24/comprs with
// the same subpath, at the same version. These tests check that it stays a
// faithful copy as the root package changes.
const ROOT = resolve(__dirname, '..');
const UNSCOPED_DIR = join(ROOT, 'packages', 'comprs');
const SCOPED = '@derodero24/comprs';
const UNSCOPED = 'comprs';
// How long the Node.js process of the import test may run. Vitest fails a
// test that outlasts its own timeout (5 s by default) even while it waits in
// execFileSync, so the test gets twice this.
const PROCESS_TIMEOUT = 30_000;

/** The fields of a package.json that these tests read. */
interface Manifest {
  readonly name: string;
  readonly version: string;
  readonly license: string;
  readonly keywords: readonly string[];
  readonly engines: Readonly<Record<string, string>>;
  readonly repository: { readonly url: string; readonly directory?: string };
  readonly exports: Readonly<Record<string, unknown>>;
  readonly files: readonly string[];
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly publishConfig: Readonly<Record<string, string>>;
}

function readManifest(dir: string): Manifest {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest;
}

const scoped = readManifest(ROOT);
const unscoped = readManifest(UNSCOPED_DIR);

/** The subpaths of the root package's `exports`: those of its entry points. */
const SUBPATHS = Object.keys(scoped.exports);

/** `pkg` followed by `subpath`, as an import names an entry point. */
function specifier(pkg: string, subpath: string): string {
  return subpath === '.' ? pkg : `${pkg}${subpath.slice(1)}`;
}

/** Every file path that a value of `exports` names, under any condition. */
function exportTargets(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).flatMap(exportTargets);
  }
  return [];
}

/**
 * The format of the module at `path`, relative to the package directory
 * `dir`: that of its extension, or for `.js`, the `type` of the nearest
 * package.json, up to `dir`.
 */
function moduleFormat(dir: string, path: string): 'module' | 'commonjs' {
  if (path.endsWith('.mjs')) {
    return 'module';
  }
  if (path.endsWith('.cjs')) {
    return 'commonjs';
  }
  for (let current = resolve(dir, path, '..'); ; current = resolve(current, '..')) {
    const manifest = join(current, 'package.json');
    if (existsSync(manifest)) {
      const { type } = JSON.parse(readFileSync(manifest, 'utf8')) as { type?: string };
      return type === 'module' ? 'module' : 'commonjs';
    }
    if (current === dir) {
      return 'commonjs';
    }
  }
}

/**
 * A value of `exports` with each module it names replaced by the module's
 * format, and each declaration file by `types`.
 */
function conditionFormats(dir: string, value: unknown): unknown {
  if (typeof value === 'string') {
    return /\.d\.[cm]?ts$/.test(value) ? 'types' : moduleFormat(dir, value);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, conditionFormats(dir, entry)]),
    );
  }
  return value;
}

/** Whether `files` of a package.json includes the file at `path`. */
function listedInFiles(files: readonly string[], path: string): boolean {
  const file = relative('.', path);
  return files.some((entry) => file === entry || file.startsWith(`${entry}/`));
}

describe('unscoped comprs package', () => {
  describe('package.json', () => {
    it('has the version, license, keywords and engines of the root package', () => {
      expect(unscoped.name).toBe(UNSCOPED);
      expect(unscoped.version).toBe(scoped.version);
      expect(unscoped.license).toBe(scoped.license);
      expect(unscoped.keywords).toEqual(scoped.keywords);
      expect(unscoped.engines).toEqual(scoped.engines);
      expect(unscoped.publishConfig).toEqual(scoped.publishConfig);
    });

    // npm rejects a package published with provenance whose repository.url
    // does not match the repository that the provenance names.
    it('names the same repository, in its own directory', () => {
      expect(unscoped.repository.url).toBe(scoped.repository.url);
      expect(unscoped.repository.directory).toBe('packages/comprs');
    });

    // pnpm pack writes the version in place of `workspace:*`, so the
    // package depends on exactly the release of the same version.
    it('depends on the root package at the same version', () => {
      expect(unscoped.dependencies).toEqual({ [SCOPED]: 'workspace:*' });
    });

    it('exports the subpaths of the root package', () => {
      const subpaths = Object.keys(unscoped.exports).filter((key) => key !== './package.json');
      expect(subpaths).toEqual(SUBPATHS);
    });

    // Each condition must load a module of the same format as the root
    // package's: an ES module where the root's is one, so that the
    // conditions of its own `export *` pick the same entry (the browser one
    // under `browser`), and a CommonJS module where the root's is one, so
    // that import sees the same names, `default` included.
    it('has the conditions of the root package, with modules of the same format', () => {
      for (const subpath of SUBPATHS) {
        expect(conditionFormats(UNSCOPED_DIR, unscoped.exports[subpath]), subpath).toEqual(
          conditionFormats(ROOT, scoped.exports[subpath]),
        );
      }
    });

    // npm publishes the LICENSE of the package directory, whatever `files`
    // says, and the package has no build step that could copy the root one.
    it('has the LICENSE of the root package', () => {
      expect(readFileSync(join(UNSCOPED_DIR, 'LICENSE'), 'utf8')).toBe(
        readFileSync(join(ROOT, 'LICENSE'), 'utf8'),
      );
    });

    it('publishes every file that its exports name', () => {
      const targets = exportTargets(unscoped.exports).filter((path) => path !== './package.json');
      expect(targets.length).toBeGreaterThan(0);
      for (const target of targets) {
        expect(existsSync(join(UNSCOPED_DIR, target)), target).toBe(true);
        expect(listedInFiles(unscoped.files, target), target).toBe(true);
      }
    });
  });

  // createRequire() from the package's own directory resolves `comprs` to
  // the package itself, through its `exports`, and @derodero24/comprs to the
  // workspace link in its node_modules.
  it('re-exports the same values through require()', () => {
    const require = createRequire(join(UNSCOPED_DIR, 'package.json'));
    for (const subpath of SUBPATHS) {
      const original = require(specifier(SCOPED, subpath)) as Record<string, unknown>;
      const copy = require(specifier(UNSCOPED, subpath)) as Record<string, unknown>;
      expect(Object.keys(copy).sort(), subpath).toEqual(Object.keys(original).sort());
      for (const [name, value] of Object.entries(original)) {
        expect(copy[name], `${subpath}: ${name}`).toBe(value);
      }
    }
  });

  // A Node.js process of its own, without Vitest's module transforms, so
  // that import resolves the entry points as an application's would. The
  // working directory makes `comprs` resolve to the package itself.
  it('re-exports the same values through import', { timeout: 2 * PROCESS_TIMEOUT }, () => {
    const script = `
      const subpaths = ${JSON.stringify(SUBPATHS)};
      const name = (pkg, subpath) => (subpath === '.' ? pkg : pkg + subpath.slice(1));
      const problems = [];
      for (const subpath of subpaths) {
        const original = await import(name(${JSON.stringify(SCOPED)}, subpath));
        const copy = await import(name(${JSON.stringify(UNSCOPED)}, subpath));
        const keys = Object.keys(original);
        if (keys.length === 0) problems.push(subpath + ' exports nothing');
        if (Object.keys(copy).join() !== keys.join()) problems.push(subpath + ': other names');
        for (const key of keys) {
          if (copy[key] !== original[key]) problems.push(subpath + ': ' + key + ' differs');
        }
      }
      process.stdout.write(JSON.stringify(problems));
    `;
    const output = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: UNSCOPED_DIR,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: PROCESS_TIMEOUT,
    });
    expect(JSON.parse(output)).toEqual([]);
  });

  // A bundler for browsers imports each entry point with the `browser` and
  // `import` conditions, and must reach the browser entry of the root
  // package through the re-export, not its native one. The plugin records
  // where each import of the root package resolves, and leaves it external,
  // so this needs no WebAssembly build.
  it('leads bundlers for browsers to the browser entry points', async () => {
    const resolved = new Map<string, string>();
    const recordScoped: Plugin = {
      name: 'record-scoped',
      setup(pluginBuild) {
        pluginBuild.onResolve({ filter: /^@derodero24\/comprs(?:\/|$)/ }, async (args) => {
          // The resolve() call below runs this callback again.
          if (args.pluginData === 'resolved') {
            return undefined;
          }
          const result = await pluginBuild.resolve(args.path, {
            kind: args.kind,
            importer: args.importer,
            resolveDir: args.resolveDir,
            pluginData: 'resolved',
          });
          if (result.errors.length > 0) {
            return { errors: result.errors };
          }
          resolved.set(args.path, relative(ROOT, result.path));
          return { path: args.path, external: true };
        });
      },
    };
    const browserSubpaths = SUBPATHS.filter((subpath) => subpath !== './node');
    await build({
      stdin: {
        contents: browserSubpaths
          .map((subpath, index) => `export * as e${index} from '${specifier(UNSCOPED, subpath)}';`)
          .join('\n'),
        resolveDir: UNSCOPED_DIR,
        sourcefile: 'app.mjs',
      },
      bundle: true,
      platform: 'browser',
      format: 'esm',
      write: false,
      plugins: [recordScoped],
      logLevel: 'silent',
    });
    expect(Object.fromEntries(resolved)).toEqual({
      [SCOPED]: join('browser', 'index.js'),
      [`${SCOPED}/streams`]: join('browser', 'streams.js'),
      [`${SCOPED}/next`]: join('browser', 'next', 'browser.js'),
    });
  });
});
