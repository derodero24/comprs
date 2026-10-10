import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

type Timings = Map<string, Map<string, number>>;
type Sizes = Record<string, { inputLength: number; sizes: Record<string, number> }>;

/** The report, which the tests only pass from one function to the next. */
interface Report {
  readonly sections: readonly unknown[];
}

interface Method {
  date: string;
  version: string;
  commit: string;
  node: string;
  cpu: string;
  cpuCount: number;
  platform: string;
  libraries: Record<string, string>;
  runUrl: string | undefined;
  runner: string | undefined;
  smoke: boolean;
}

interface BenchRender {
  START_MARKER: string;
  END_MARKER: string;
  parseVitestReport(report: unknown): Timings;
  parseSizes(value: unknown): Sizes;
  collectReport(timings: Timings, sizes: Sizes): Report;
  renderMarkdown(report: Report, method: Method): string;
  renderCompressChart(report: Report, method: Method): string;
  renderCrossAlgorithmChart(report: Report, method: Method): string;
  replaceSection(readme: string, content: string): string;
}

// bench-render.mjs has no declaration file, so a literal specifier would not
// type-check; the module is loaded through its URL and typed here instead.
const BENCH_RENDER = pathToFileURL(resolve(__dirname, '../scripts/bench-render.mjs')).href;

let render: BenchRender;

beforeAll(async () => {
  render = (await import(BENCH_RENDER)) as BenchRender;
});

/** A report of Vitest's JSON reporter: the median time of each benchmark of each test. */
function vitestReport(tests: Record<string, Record<string, number>>): unknown {
  return {
    testResults: [
      {
        assertionResults: Object.entries(tests).map(([fullName, medians]) => ({
          fullName,
          status: 'passed',
          benchmarks: [
            {
              name: fullName,
              tasks: Object.entries(medians).map(([name, p50]) => ({ name, latency: { p50 } })),
            },
          ],
        })),
      },
    ],
  };
}

const METHOD: Method = {
  date: '2026-10-10',
  version: '2.0.2',
  commit: 'abc1234',
  node: 'v24.11.1',
  cpu: 'Test CPU',
  cpuCount: 4,
  platform: 'linux/x64',
  libraries: { pako: '3.0.2', fflate: '0.8.3' },
  runUrl: 'https://github.com/derodero24/comprs/actions/runs/1',
  runner: 'a GitHub-hosted runner (ubuntu24, image 20261005.1)',
  smoke: false,
};

// 100,000 bytes: 1 ms per call is 100 MB/s.
const SIZES: Sizes = {
  'gzip level 6 - JSON 84KB': { inputLength: 100_000, sizes: { comprs: 10_000, pako: 12_500 } },
  'gzip level 6 - text 150B': { inputLength: 150, sizes: { comprs: 50, pako: 60 } },
  'comprs default levels - JSON 84KB': {
    inputLength: 100_000,
    sizes: { zstd: 10_000, gzip: 12_500, brotli: 8_000, lz4: 20_000 },
  },
  'gzip stream level 6 - patterned 1MB in 16KB chunks': {
    inputLength: 1_000_000,
    sizes: { comprs: 5_000, 'node:zlib': 4_000 },
  },
};

// Vitest lists the benchmarks of a test fastest first, and the benchmark
// files in any order.
const TIMINGS = {
  'gzip compress level 6 - JSON 84KB': { pako: 0.5, comprs: 1 },
  'gzip decompress level 6 - JSON 84KB': { comprs: 0.25, pako: 0.4 },
  'gzip compress level 6 - text 150B': { comprs: 0.001 },
  'gzip decompress level 6 - text 150B': { comprs: 0.0005, pako: 0.002 },
  'gzip stream compress level 6 - patterned 1MB in 16KB chunks': { 'node:zlib': 5, comprs: 10 },
  'comprs compress default levels - JSON 84KB': { zstd: 0.2, lz4: 0.25, gzip: 1, brotli: 4 },
  'comprs decompress default levels - JSON 84KB': { zstd: 0.1, lz4: 0.1, gzip: 0.5, brotli: 1 },
};

function report(timings: Record<string, Record<string, number>> = TIMINGS): Report {
  return render.collectReport(
    render.parseVitestReport(vitestReport(timings)),
    render.parseSizes(SIZES),
  );
}

describe('bench report', () => {
  it('tabulates MB/s and compression ratios, the libraries in the order of the benchmarks', () => {
    const markdown = render.renderMarkdown(report(), METHOD);
    // The compression, decompression and ratio tables of gzip.
    expect(markdown).toContain(
      [
        '| Input | comprs | pako |',
        '| --- | ---: | ---: |',
        '| JSON 84KB | 100 | 200 |',
        // pako has no result for the 150 B input.
        '| text 150B | 150 | — |',
      ].join('\n'),
    );
    expect(markdown).toContain('| JSON 84KB | 400 | 250 |\n| text 150B | 300 | 75.0 |');
    expect(markdown).toContain('| JSON 84KB | 10.0 | 8.00 |\n| text 150B | 3.00 | 2.50 |');
    expect(markdown).toContain(
      '| gzip compress, level 6 | patterned 1MB in 16KB chunks | 100 | 200 |',
    );
  });

  it('puts the cross-algorithm table first, whatever order the files ran in', () => {
    const markdown = render.renderMarkdown(report(), METHOD);
    const cross = markdown.indexOf('Cross-algorithm comparison: zstd vs gzip vs brotli vs lz4');
    const gzip = markdown.indexOf('gzip, level 6: comprs vs pako');
    expect(cross).toBeGreaterThan(-1);
    expect(gzip).toBeGreaterThan(cross);
  });

  it('states the versions, the machine, the run and the settings', () => {
    const markdown = render.renderMarkdown(report(), METHOD);
    expect(markdown).toContain(
      'Measured on 2026-10-10 with comprs 2.0.2 (`abc1234`), Node.js v24.11.1, pako 3.0.2 and fflate 0.8.3, on Test CPU × 4 (linux/x64), in [this run](https://github.com/derodero24/comprs/actions/runs/1) of the Bench Report workflow, on a GitHub-hosted runner (ubuntu24, image 20261005.1).',
    );
    expect(markdown).toContain('gzip level 6 · streams: gzip level 6 ·');
    expect(markdown).not.toContain('BENCH_SMOKE');
    expect(render.renderMarkdown(report(), { ...METHOD, smoke: true })).toContain(
      '**BENCH_SMOKE=1 ran every benchmark once',
    );
    expect(
      render.renderMarkdown(report(), { ...METHOD, runUrl: undefined, runner: undefined }),
    ).toContain('on a local machine, not in the Bench Report workflow');
  });

  it('draws the charts', () => {
    const compress = render.renderCompressChart(report(), METHOD);
    expect(compress).toMatch(/^<svg [^>]+>\n[\s\S]*\n<\/svg>\n$/);
    // pako, the fastest, gets the longest bar; comprs is not faster than it.
    expect(compress).toContain('<rect x="120" y="60" width="360" height="28"');
    expect(compress).toContain('>200 MB/s</text>');
    expect(compress).not.toContain('x vs pako');

    const cross = render.renderCrossAlgorithmChart(report(), METHOD);
    expect(cross).toMatch(/^<svg [^>]+>\n[\s\S]*\n<\/svg>\n$/);
    for (const format of ['zstd', 'gzip', 'brotli', 'lz4']) {
      expect(cross).toContain(`text-anchor="end">${format}</text>`);
    }
    expect(cross).toContain('>ratio 12.5</text>');
    expect(cross).toContain('>1,000 MB/s</text>');
  });

  it('says how many times faster comprs is than the libraries it beats', () => {
    const timings = {
      ...TIMINGS,
      'gzip compress level 6 - JSON 84KB': { comprs: 0.5, pako: 1 },
    };
    expect(render.renderCompressChart(report(timings), METHOD)).toContain('>2.0x vs pako</text>');
  });

  it('draws the fastest library first, whatever order the benchmarks ran in', () => {
    const timings = {
      ...TIMINGS,
      'gzip compress level 6 - JSON 84KB': { comprs: 1, pako: 0.5 },
    };
    const compress = render.renderCompressChart(report(timings), METHOD);
    const labels = [...compress.matchAll(/class="bar-label" text-anchor="end">([^<]+)</g)];
    expect(labels.map(([, library]) => library)).toEqual(['pako', 'comprs']);
    expect(compress).toContain('<rect x="120" y="60" width="360" height="28"');
  });

  it('rounds before it chooses the precision', () => {
    // 1 ms per call of the JSON input, and 1.5 µs of the text input, is 100 MB/s.
    const timings = {
      ...TIMINGS,
      'gzip compress level 6 - JSON 84KB': { comprs: 1 / 0.9997, pako: 1 / 0.09996 },
      'gzip compress level 6 - text 150B': { comprs: 0.0015 / 0.9994, pako: 0.0015 / 0.09994 },
    };
    expect(render.renderMarkdown(report(timings), METHOD)).toContain(
      '| JSON 84KB | 100 | 10.0 |\n| text 150B | 99.9 | 9.99 |',
    );
  });

  it('shows no speed for a median time of 0 or NaN', () => {
    const timings = {
      ...TIMINGS,
      // A median of 0 gives an infinite speed, and NaN no speed at all.
      'gzip compress level 6 - JSON 84KB': { comprs: 0, pako: 1 },
      'comprs decompress default levels - JSON 84KB': {
        zstd: Number.NaN,
        lz4: 0.1,
        gzip: 0.5,
        brotli: 1,
      },
    };
    const markdown = render.renderMarkdown(report(timings), METHOD);
    expect(markdown).toContain('| JSON 84KB | — | 100 |\n| text 150B | 150 | — |');
    expect(markdown).toContain('| JSON 84KB | — | 200 | 100 | 1,000 |');
    const compress = render.renderCompressChart(report(timings), METHOD);
    const cross = render.renderCrossAlgorithmChart(report(timings), METHOD);
    for (const output of [markdown, compress, cross]) {
      expect(output).not.toMatch(/NaN|Infinity|∞/);
    }
    // comprs has no bar, and no multiplier against pako.
    expect(compress).not.toContain('>comprs</text>');
    expect(compress).not.toContain('x vs pako');
    expect(cross).toContain('>1,000 MB/s</text>');
  });

  it('rejects a test that ran no benchmark, and a report without tests', () => {
    expect(() =>
      render.parseVitestReport({
        testResults: [
          {
            assertionResults: [
              { fullName: 'a test', status: 'passed', benchmarks: [{ tasks: [] }] },
            ],
          },
        ],
      }),
    ).toThrow('a test ran no benchmark');
    expect(() => render.parseVitestReport({ testResults: [{ assertionResults: [] }] })).toThrow(
      'the Vitest report has no test',
    );
  });

  it('rejects results that it cannot place', () => {
    expect(() => report({ ...TIMINGS, 'lz4 compress - JSON 84KB': { comprs: 1 } })).toThrow(
      'not a benchmark that the report knows',
    );
    expect(() =>
      report({ ...TIMINGS, 'zstd compress level 3 - JSON 84KB': { comprs: 1 } }),
    ).toThrow('no sizes were recorded for zstd level 3 - JSON 84KB');
    expect(() =>
      render.parseVitestReport({
        testResults: [{ assertionResults: [{ fullName: 'a test', status: 'failed' }] }],
      }),
    ).toThrow('a test did not pass');
    expect(() => render.parseSizes({ 'a group': { sizes: {} } })).toThrow(
      'the sizes of a group have no input length or sizes',
    );
  });

  it('replaces the text between the markers and nothing else', () => {
    const { START_MARKER, END_MARKER } = render;
    const readme = `# Title\n\n${START_MARKER}\nold\n${END_MARKER}\n\n## Next\n`;
    expect(render.replaceSection(readme, 'new')).toBe(
      `# Title\n\n${START_MARKER}\nnew\n${END_MARKER}\n\n## Next\n`,
    );
  });

  it.each([
    ['no markers', '# Title\n'],
    ['no end marker', '<!-- bench:start -->\n'],
    ['the markers in the wrong order', '<!-- bench:end -->\n<!-- bench:start -->\n'],
    ['two start markers', '<!-- bench:start -->\n<!-- bench:start -->\n<!-- bench:end -->\n'],
  ])('throws on a README with %s', (_, readme) => {
    expect(() => render.replaceSection(readme, 'new')).toThrow(
      'README.md must hold <!-- bench:start --> and then <!-- bench:end -->, once each',
    );
  });
});
