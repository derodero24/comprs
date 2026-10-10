/**
 * Renders the results of the comparison benchmarks, __test__/*.compare.bench.ts,
 * as the Benchmarks section of README.md and its two SVG charts, for
 * scripts/bench-report.mjs. Kept apart from that script, which runs the
 * benchmarks, so that __test__/bench-report.spec.ts can test it.
 *
 * The benchmarks name their tests `<format> compress <setting> - <input>` and
 * `<format> decompress <setting> - <input>` (compareLibraries in
 * __test__/bench-fixtures.ts), and `<format> stream <operation> <setting> -
 * <input>` (__test__/streaming.compare.bench.ts), and record the input length
 * and the compressed sizes of each `<format> <setting> - <input>` and
 * `<format> stream <setting> - <input>` (recordSizes).
 */

export const START_MARKER = '<!-- bench:start -->';
export const END_MARKER = '<!-- bench:end -->';

/** The format name of the comparison of comprs's own formats. */
const CROSS_ALGORITHM = 'comprs';

/** The order of the tables; the benchmark files run in any order. */
const FORMAT_ORDER = [CROSS_ALGORITHM, 'gzip', 'deflate', 'brotli', 'zstd'];

/** The input of both charts. */
const CHART_INPUT = 'JSON 84KB';

/** The format of the chart that compares comprs with other libraries. */
const CHART_FORMAT = 'gzip';

/** The paths of the charts, relative to the repository root. */
export const COMPRESS_CHART = '.github/assets/bench-compress.svg';
export const CROSS_ALGORITHM_CHART = '.github/assets/bench-cross-algorithm.svg';

const ONE_SHOT_TEST = /^(\S+) (compress|decompress) (.+?) - (.+)$/;
const STREAM_TEST = /^(\S+) stream (compress|decompress|round-trip) (.+?) - (.+)$/;

/**
 * Median time of one call of each library's benchmark, in milliseconds, by
 * test name and then by library.
 *
 * @typedef {Map<string, Map<string, number>>} Timings
 */

/**
 * @typedef {object} SizeGroup
 * @property {number} inputLength Bytes of uncompressed data.
 * @property {Record<string, number>} sizes Bytes of each library's output.
 */

/** @typedef {Record<string, SizeGroup>} Sizes */

/**
 * @typedef {object} Row
 * @property {string} input The input label, such as 'JSON 84KB'.
 * @property {SizeGroup} group
 * @property {Map<string, number>} compress MB/s of each library.
 * @property {Map<string, number>} decompress MB/s of each library.
 */

/**
 * A table of one format at one setting.
 *
 * @typedef {object} Section
 * @property {string} format
 * @property {string} setting
 * @property {string[]} libraries
 * @property {Row[]} rows
 */

/**
 * @typedef {object} StreamRow
 * @property {string} format
 * @property {string} setting
 * @property {string} operation 'compress', 'decompress' or 'round-trip'.
 * @property {string} input
 * @property {Map<string, number>} speeds MB/s of each library.
 */

/**
 * @typedef {object} Report
 * @property {Section[]} sections
 * @property {StreamRow[]} streams
 * @property {string[]} streamLibraries
 */

/**
 * Where and how the benchmarks ran.
 *
 * @typedef {object} Method
 * @property {string} date ISO date, such as '2026-10-10'.
 * @property {string} version comprs version.
 * @property {string} commit Abbreviated commit hash.
 * @property {string} node Node.js version, such as 'v24.11.1'.
 * @property {string} cpu CPU model.
 * @property {number} cpuCount
 * @property {string} platform Platform and architecture, such as 'linux/x64'.
 * @property {Record<string, string>} libraries Version of each other library.
 * @property {string | undefined} runUrl The GitHub Actions run, if any.
 * @property {string | undefined} runner The GitHub Actions runner, if any, such as
 *   'a GitHub-hosted runner (ubuntu24, image 20261005.1)'.
 * @property {boolean} smoke Whether BENCH_SMOKE=1 ran each benchmark once.
 */

/**
 * Whether a value is a plain object, such as a JSON object.
 *
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The elements of `value[key]`, which must be an array.
 *
 * @param {Record<string, unknown>} value
 * @param {string} key
 * @returns {unknown[]}
 */
function arrayAt(value, key) {
  const array = value[key];
  if (!Array.isArray(array)) {
    throw new Error(`the Vitest report has no ${key} array`);
  }
  return array;
}

/**
 * Reads the median time of every benchmark from a report of Vitest's JSON
 * reporter (`vitest bench --reporter=json`).
 *
 * @param {unknown} report
 * @returns {Timings}
 */
export function parseVitestReport(report) {
  if (!isRecord(report)) {
    throw new Error('the Vitest report is not a JSON object');
  }
  /** @type {Timings} */
  const timings = new Map();
  for (const file of arrayAt(report, 'testResults')) {
    if (!isRecord(file)) {
      throw new Error('the Vitest report has a test file that is not an object');
    }
    for (const test of arrayAt(file, 'assertionResults')) {
      if (!isRecord(test) || typeof test['fullName'] !== 'string') {
        throw new Error('the Vitest report has a test without a name');
      }
      if (test['status'] !== 'passed') {
        throw new Error(`${test['fullName']} did not pass`);
      }
      timings.set(test['fullName'], parseBenchmarks(test['fullName'], test));
    }
  }
  if (timings.size === 0) {
    throw new Error('the Vitest report has no test');
  }
  return timings;
}

/**
 * The median time of each library's benchmark in one test.
 *
 * @param {string} name
 * @param {Record<string, unknown>} test
 * @returns {Map<string, number>}
 */
function parseBenchmarks(name, test) {
  /** @type {Map<string, number>} */
  const medians = new Map();
  for (const benchmark of arrayAt(test, 'benchmarks')) {
    if (!isRecord(benchmark)) {
      throw new Error(`${name} has a benchmark that is not an object`);
    }
    for (const task of arrayAt(benchmark, 'tasks')) {
      medians.set(...parseTask(name, task));
    }
  }
  if (medians.size === 0) {
    throw new Error(`${name} ran no benchmark`);
  }
  return medians;
}

/**
 * The library name and the median time of one benchmark.
 *
 * @param {string} name The name of the test.
 * @param {unknown} task
 * @returns {[string, number]}
 */
function parseTask(name, task) {
  const latency = isRecord(task) ? task['latency'] : undefined;
  const median = isRecord(latency) ? latency['p50'] : undefined;
  if (!isRecord(task) || typeof task['name'] !== 'string' || typeof median !== 'number') {
    throw new Error(`${name} has a benchmark without a name or a median time`);
  }
  return [task['name'], median];
}

/**
 * Checks the sizes that recordSizes wrote.
 *
 * @param {unknown} value
 * @returns {Sizes}
 */
export function parseSizes(value) {
  if (!isRecord(value)) {
    throw new Error('the sizes are not a JSON object');
  }
  /** @type {Sizes} */
  const groups = {};
  for (const [group, entry] of Object.entries(value)) {
    const inputLength = isRecord(entry) ? entry['inputLength'] : undefined;
    const sizes = isRecord(entry) ? entry['sizes'] : undefined;
    if (typeof inputLength !== 'number' || !isRecord(sizes)) {
      throw new Error(`the sizes of ${group} have no input length or sizes`);
    }
    /** @type {Record<string, number>} */
    const checked = {};
    for (const [library, size] of Object.entries(sizes)) {
      if (typeof size !== 'number') {
        throw new Error(`the size of ${library} in ${group} is not a number`);
      }
      checked[library] = size;
    }
    groups[group] = { inputLength, sizes: checked };
  }
  return groups;
}

/**
 * The sizes of a group, which must have been recorded.
 *
 * @param {Sizes} sizes
 * @param {string} group
 * @returns {SizeGroup}
 */
function sizeGroup(sizes, group) {
  const entry = sizes[group];
  if (entry === undefined) {
    throw new Error(`no sizes were recorded for ${group}`);
  }
  return entry;
}

/**
 * MB/s (10^6 bytes per second) of uncompressed data, from the median time of
 * a call in milliseconds.
 *
 * @param {SizeGroup} group
 * @param {Map<string, number>} medians
 * @returns {Map<string, number>}
 */
function speeds(group, medians) {
  return new Map(
    [...medians].map(([library, milliseconds]) => [
      library,
      group.inputLength / milliseconds / 1000,
    ]),
  );
}

/**
 * Appends `values` to `list`, without duplicates.
 *
 * @param {string[]} list
 * @param {Iterable<string>} values
 */
function addAll(list, values) {
  for (const value of values) {
    if (!list.includes(value)) {
      list.push(value);
    }
  }
}

/**
 * Sorts the tables in FORMAT_ORDER, keeping the order of the settings of a
 * format.
 *
 * @param {Section[]} sections
 * @returns {Section[]}
 */
function sortSections(sections) {
  /** @param {Section} section */
  const rank = (section) => {
    const index = FORMAT_ORDER.indexOf(section.format);
    return index === -1 ? FORMAT_ORDER.length : index;
  };
  return sections.toSorted((a, b) => rank(a) - rank(b));
}

/**
 * Groups the timings into tables, and computes the speeds from the sizes.
 * Throws on a test that the report does not know, so that no result is left
 * out silently.
 *
 * @param {Timings} timings
 * @param {Sizes} sizes
 * @returns {Report}
 */
export function collectReport(timings, sizes) {
  /** @type {Report} */
  const report = { sections: [], streams: [], streamLibraries: [] };
  for (const [name, medians] of timings) {
    const stream = STREAM_TEST.exec(name);
    const oneShot = ONE_SHOT_TEST.exec(name);
    if (stream !== null) {
      addStream(report, sizes, stream, medians);
    } else if (oneShot !== null) {
      addOneShot(report, sizes, oneShot, medians);
    } else {
      throw new Error(`${name} is not a benchmark that the report knows`);
    }
  }
  return { ...report, sections: sortSections(report.sections) };
}

/**
 * Adds the result of a stream test to the report.
 *
 * @param {Report} report
 * @param {Sizes} sizes
 * @param {RegExpExecArray} match The match of STREAM_TEST.
 * @param {Map<string, number>} medians
 */
function addStream(report, sizes, match, medians) {
  const [, format = '', operation = '', setting = '', input = ''] = match;
  const group = sizeGroup(sizes, `${format} stream ${setting} - ${input}`);
  report.streams.push({ format, setting, operation, input, speeds: speeds(group, medians) });
  // Vitest lists the benchmarks of a test fastest first, while the sizes keep
  // the order of the libraries.
  addAll(report.streamLibraries, Object.keys(group.sizes));
  addAll(report.streamLibraries, medians.keys());
}

/**
 * Adds the result of a one-shot compress or decompress test to the report.
 *
 * @param {Report} report
 * @param {Sizes} sizes
 * @param {RegExpExecArray} match The match of ONE_SHOT_TEST.
 * @param {Map<string, number>} medians
 */
function addOneShot(report, sizes, match, medians) {
  const [, format = '', operation = '', setting = '', input = ''] = match;
  let section = report.sections.find(
    (candidate) => candidate.format === format && candidate.setting === setting,
  );
  if (section === undefined) {
    section = { format, setting, libraries: [], rows: [] };
    report.sections.push(section);
  }
  let row = section.rows.find((candidate) => candidate.input === input);
  if (row === undefined) {
    const group = sizeGroup(sizes, `${format} ${setting} - ${input}`);
    row = { input, group, compress: new Map(), decompress: new Map() };
    section.rows.push(row);
    // The sizes keep the order of the libraries; see addStream.
    addAll(section.libraries, Object.keys(group.sizes));
  }
  row[operation === 'compress' ? 'compress' : 'decompress'] = speeds(row.group, medians);
  addAll(section.libraries, medians.keys());
}

/**
 * Formats a speed or a ratio with three significant digits or more. The
 * precision follows the rounded value, so that 99.97 gives 100, not 100.0,
 * and 9.996 gives 10.0, not 10.00.
 *
 * @param {number | undefined} value
 * @returns {string}
 */
function formatNumber(value) {
  if (value === undefined || !Number.isFinite(value)) {
    return '—';
  }
  if (Number(value.toFixed(1)) >= 100) {
    return Math.round(value).toLocaleString('en-US');
  }
  return value.toFixed(Number(value.toFixed(2)) >= 10 ? 1 : 2);
}

/**
 * The compression ratio of a library: input size ÷ output size.
 *
 * @param {SizeGroup} group
 * @param {string} library
 * @returns {number | undefined}
 */
function ratio(group, library) {
  const size = group.sizes[library];
  return size === undefined ? undefined : group.inputLength / size;
}

/**
 * A Markdown table.
 *
 * @param {string[]} header
 * @param {string[][]} rows
 * @param {number} textColumns The number of left-aligned columns at the start.
 * @returns {string}
 */
function table(header, rows, textColumns) {
  const align = header.map((_, index) => (index < textColumns ? '---' : '---:'));
  return [header, align, ...rows].map((cells) => `| ${cells.join(' | ')} |`).join('\n');
}

/**
 * The title of a table.
 *
 * @param {Section} section
 * @returns {string}
 */
function sectionTitle(section) {
  if (section.format === CROSS_ALGORITHM) {
    return `Cross-algorithm comparison: ${section.libraries.join(' vs ')} (comprs only, ${section.setting})`;
  }
  return `${section.format}, ${section.setting}: ${section.libraries.join(' vs ')}`;
}

/**
 * @param {Section} section
 * @returns {string}
 */
function renderSection(section) {
  const header = ['Input', ...section.libraries];
  /** @param {(row: Row, library: string) => number | undefined} value */
  const rows = (value) =>
    section.rows.map((row) => [
      row.input,
      ...section.libraries.map((library) => formatNumber(value(row, library))),
    ]);
  return [
    '<details>',
    `<summary><strong>${sectionTitle(section)}</strong></summary>`,
    '',
    '**Compression** (MB/s of uncompressed data, higher is better)',
    '',
    table(
      header,
      rows((row, library) => row.compress.get(library)),
      1,
    ),
    '',
    '**Decompression** (MB/s of uncompressed data, higher is better)',
    '',
    table(
      header,
      rows((row, library) => row.decompress.get(library)),
      1,
    ),
    '',
    '**Compression ratio** (input size ÷ output size, higher is better)',
    '',
    table(
      header,
      rows((row, library) => ratio(row.group, library)),
      1,
    ),
    '',
    '</details>',
  ].join('\n');
}

/**
 * @param {Report} report
 * @returns {string}
 */
function renderStreams(report) {
  const rows = report.streams.map((row) => [
    `${row.format} ${row.operation}, ${row.setting}`,
    row.input,
    ...report.streamLibraries.map((library) => formatNumber(row.speeds.get(library))),
  ]);
  return [
    '<details>',
    `<summary><strong>Node.js streams: ${report.streamLibraries.join(' vs ')}</strong></summary>`,
    '',
    '**Transform streams** (MB/s of uncompressed data, higher is better)',
    '',
    table(['Stream', 'Input', ...report.streamLibraries], rows, 2),
    '',
    '</details>',
  ].join('\n');
}

/**
 * Lists items as 'a, b and c'.
 *
 * @param {string[]} items
 * @returns {string}
 */
function list(items) {
  return items.length <= 1
    ? items.join('')
    : `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`;
}

/**
 * The paragraph that says where, how and with what the benchmarks ran.
 *
 * @param {Report} report
 * @param {Method} method
 * @returns {string}
 */
function describeMethod(report, method) {
  const libraries = Object.entries(method.libraries).map(([name, version]) => `${name} ${version}`);
  const where =
    method.runUrl === undefined
      ? 'on a local machine, not in the Bench Report workflow'
      : `in [this run](${method.runUrl}) of the Bench Report workflow, on ${method.runner ?? 'a GitHub Actions runner'}`;
  const settings = [
    ...report.sections
      .filter((section) => section.format !== CROSS_ALGORITHM)
      .map((section) => `${section.format} ${section.setting}`),
    `streams: ${[...new Set(report.streams.map((row) => `${row.format} ${row.setting}`))].join(', ')}`,
    "cross-algorithm: each format's default level",
  ];
  const paragraph = [
    `Measured on ${method.date} with comprs ${method.version} (\`${method.commit}\`), ${list([`Node.js ${method.node}`, ...libraries])}, on ${method.cpu} × ${method.cpuCount} (${method.platform}), ${where}.`,
    `Settings, the same for every library in a table: ${settings.join(' · ')}.`,
    'Speeds are MB/s of uncompressed data (1 MB = 1,000,000 bytes), from the median time of a call.',
    'Every library decompresses the output of comprs, so that only the decoders differ, except in the cross-algorithm table, where each format decompresses its own.',
    'The compression ratio is the input size divided by the output size.',
  ].join(' ');
  return method.smoke
    ? `**BENCH_SMOKE=1 ran every benchmark once, without warmup: these numbers mean nothing.** ${paragraph}`
    : paragraph;
}

/**
 * A section of the report, which must exist.
 *
 * @param {Report} report
 * @param {string} format
 * @returns {Section}
 */
function findSection(report, format) {
  const section = report.sections.find((candidate) => candidate.format === format);
  if (section === undefined) {
    throw new Error(`the report has no ${format} table`);
  }
  return section;
}

/**
 * The row of an input, which must exist.
 *
 * @param {Section} section
 * @param {string} input
 * @returns {Row}
 */
function findRow(section, input) {
  const row = section.rows.find((candidate) => candidate.input === input);
  if (row === undefined) {
    throw new Error(`the ${section.format} ${section.setting} table has no ${input} row`);
  }
  return row;
}

/**
 * The Benchmarks section of the README, between the markers.
 *
 * @param {Report} report
 * @param {Method} method
 * @returns {string}
 */
export function renderMarkdown(report, method) {
  const compressed = findSection(report, CHART_FORMAT);
  const cross = findSection(report, CROSS_ALGORITHM);
  return [
    '<!-- Generated by scripts/bench-report.mjs (see CONTRIBUTING.md): edit the scripts, not this section. -->',
    describeMethod(report, method),
    `<img src="${CROSS_ALGORITHM_CHART}" alt="Compression and decompression speed of ${list(cross.libraries)} in comprs on ${CHART_INPUT}" width="680" />`,
    `<img src="${COMPRESS_CHART}" alt="${CHART_FORMAT} compression speed of ${list(compressed.libraries)} on ${CHART_INPUT}" width="680" />`,
    ...report.sections.map(renderSection),
    renderStreams(report),
  ].join('\n\n');
}

/**
 * Replaces the text between the markers of the README.
 *
 * @param {string} readme
 * @param {string} content
 * @returns {string}
 */
export function replaceSection(readme, content) {
  const start = readme.indexOf(START_MARKER);
  const end = readme.indexOf(END_MARKER);
  if (
    start === -1 ||
    end < start ||
    readme.includes(START_MARKER, start + 1) ||
    readme.includes(END_MARKER, end + 1)
  ) {
    throw new Error(`README.md must hold ${START_MARKER} and then ${END_MARKER}, once each`);
  }
  return `${readme.slice(0, start + START_MARKER.length)}\n${content}\n${readme.slice(end)}`;
}

// --- Charts ---
// The style of the charts that the README showed before this script.

const WIDTH = 680;
const LABEL_X = 112;
const BAR_X = 120;
const BAR_MAX = 360;
const COMPRS_COLOR = '#3b82f6';
const OTHER_COLOR = '#94a3b8';
const FORMAT_COLORS = new Map([
  ['zstd', '#3b82f6'],
  ['gzip', '#f59e0b'],
  ['brotli', '#a855f7'],
  ['lz4', '#22c55e'],
]);

/**
 * Escapes text for XML.
 *
 * @param {string} text
 * @returns {string}
 */
function escapeXml(text) {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * Rounds a coordinate to two decimals.
 *
 * @param {number} value
 * @returns {number}
 */
function px(value) {
  return Math.round(value * 100) / 100;
}

/**
 * The width of a bar: at least 2 pixels, so that every bar shows.
 *
 * @param {number} value
 * @param {number} max
 * @returns {number}
 */
function barWidth(value, max) {
  return px(Math.max(2, (BAR_MAX * value) / max));
}

/**
 * An estimate of the width of a 12px text, for placing the text after it.
 *
 * @param {string} text
 * @returns {number}
 */
function textWidth(text) {
  return text.length * 7;
}

/**
 * The subtitle of a chart.
 *
 * @param {Method} method
 * @returns {string}
 */
function chartSubtitle(method) {
  return `${method.cpu} × ${method.cpuCount} · Node.js ${method.node} · MB/s (higher is better)`;
}

/**
 * The start of a chart: its frame, styles and titles.
 *
 * @param {number} height
 * @param {string} title
 * @param {string} subtitle
 * @returns {string[]}
 */
function chartHeader(height, title, subtitle) {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${height}" width="${WIDTH}" height="${height}">`,
    '<style>',
    '  text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }',
    '  .title { font-size: 16px; font-weight: 600; fill: #1f2937; }',
    '  .subtitle { font-size: 12px; fill: #6b7280; }',
    '  .bar-label { font-size: 12px; fill: #4b5563; }',
    '  .bar-value { font-size: 12px; fill: #374151; font-weight: 500; }',
    '  .multiplier { font-size: 11px; fill: #059669; font-weight: 600; }',
    '  .note { font-size: 11px; fill: #6b7280; font-style: italic; }',
    '  .legend { font-size: 11px; fill: #4b5563; }',
    '</style>',
    `<rect width="${WIDTH}" height="${height}" rx="8" fill="#ffffff" />`,
    `<rect x="0.5" y="0.5" width="${WIDTH - 1}" height="${height - 1}" rx="8" fill="none" stroke="#e5e7eb" />`,
    `<text x="20" y="28" class="title">${escapeXml(title)}</text>`,
    `<text x="20" y="44" class="subtitle">${escapeXml(subtitle)}</text>`,
  ];
}

/**
 * The compression speed of comprs and the other libraries for one format, on
 * CHART_INPUT, fastest first.
 *
 * @param {Report} report
 * @param {Method} method
 * @returns {string}
 */
export function renderCompressChart(report, method) {
  const section = findSection(report, CHART_FORMAT);
  const row = findRow(section, CHART_INPUT);
  const bars = [...row.compress]
    .filter(([, speed]) => Number.isFinite(speed))
    .sort(([, a], [, b]) => b - a);
  const comprs = row.compress.get('comprs') ?? Number.NaN;
  const max = Math.max(...bars.map(([, speed]) => speed));
  const height = 76 + bars.length * 36;
  const lines = chartHeader(
    height,
    `${CHART_FORMAT} compression, ${section.setting} — ${CHART_INPUT}`,
    chartSubtitle(method),
  );
  for (const [index, [library, speed]] of bars.entries()) {
    const y = 60 + index * 36;
    const width = barWidth(speed, max);
    const value = `${formatNumber(speed)} MB/s`;
    const fill =
      library === 'comprs' ? `fill="${COMPRS_COLOR}"` : `fill="${OTHER_COLOR}" opacity="0.65"`;
    lines.push(
      `<text x="${LABEL_X}" y="${y + 18}" class="bar-label" text-anchor="end">${escapeXml(library)}</text>`,
      `<rect x="${BAR_X}" y="${y}" width="${width}" height="28" rx="4" ${fill} />`,
      `<text x="${px(BAR_X + width + 8)}" y="${y + 18}" class="bar-value">${value}</text>`,
    );
    // How many times faster comprs is, on the libraries that it beats. A speed
    // that is not finite, which has no bar, gets no multiplier either.
    const multiplier = comprs / speed;
    if (library !== 'comprs' && multiplier > 1 && Number.isFinite(multiplier)) {
      lines.push(
        `<text x="${px(BAR_X + width + 20 + textWidth(value))}" y="${y + 18}" class="multiplier">${multiplier.toFixed(1)}x vs ${escapeXml(library)}</text>`,
      );
    }
  }
  lines.push('</svg>', '');
  return lines.join('\n');
}

/**
 * The compression and decompression speeds and the compression ratio of each
 * of comprs's formats, at its default level, on CHART_INPUT.
 *
 * @param {Report} report
 * @param {Method} method
 * @returns {string}
 */
export function renderCrossAlgorithmChart(report, method) {
  const section = findSection(report, CROSS_ALGORITHM);
  const row = findRow(section, CHART_INPUT);
  const max = Math.max(
    ...[...row.compress.values(), ...row.decompress.values()].filter(Number.isFinite),
  );
  const height = 68 + section.libraries.length * 44;
  const lines = chartHeader(
    height,
    `comprs formats at their default levels — ${CHART_INPUT}`,
    chartSubtitle(method),
  );
  lines.push(
    '<rect x="512" y="19" width="10" height="10" rx="2" fill="#6b7280" />',
    '<text x="527" y="28" class="legend">compress</text>',
    '<rect x="584" y="19" width="10" height="10" rx="2" fill="#6b7280" opacity="0.45" />',
    '<text x="599" y="28" class="legend">decompress</text>',
  );
  for (const [index, format] of section.libraries.entries()) {
    const y = 60 + index * 44;
    const color = FORMAT_COLORS.get(format) ?? OTHER_COLOR;
    lines.push(
      `<text x="${LABEL_X}" y="${y + 20}" class="bar-label" text-anchor="end">${escapeXml(format)}</text>`,
    );
    const bars = [
      { offset: 0, speed: row.compress.get(format), opacity: '' },
      { offset: 18, speed: row.decompress.get(format), opacity: ' opacity="0.45"' },
    ];
    for (const { offset, speed, opacity } of bars) {
      if (speed === undefined || !Number.isFinite(speed)) {
        continue;
      }
      const width = barWidth(speed, max);
      lines.push(
        `<rect x="${BAR_X}" y="${y + offset}" width="${width}" height="14" rx="3" fill="${color}"${opacity} />`,
        `<text x="${px(BAR_X + width + 8)}" y="${y + offset + 11}" class="bar-value">${formatNumber(speed)} MB/s</text>`,
      );
    }
    lines.push(
      `<text x="${WIDTH - 20}" y="${y + 20}" class="note" text-anchor="end">ratio ${formatNumber(ratio(row.group, format))}</text>`,
    );
  }
  lines.push('</svg>', '');
  return lines.join('\n');
}
