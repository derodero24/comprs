// --- Sample data ---
const SAMPLES = {
  json: JSON.stringify(
    {
      users: [
        { id: 1, name: 'Alice', email: 'alice@example.com', role: 'admin', active: true },
        { id: 2, name: 'Bob', email: 'bob@example.com', role: 'editor', active: true },
        { id: 3, name: 'Carol', email: 'carol@example.com', role: 'viewer', active: false },
        { id: 4, name: 'Dave', email: 'dave@example.com', role: 'editor', active: true },
        { id: 5, name: 'Eve', email: 'eve@example.com', role: 'admin', active: true },
      ],
      pagination: { page: 1, perPage: 20, total: 5, totalPages: 1 },
      meta: { generatedAt: '2025-01-15T10:23:45Z', version: '2.1.0', requestId: 'req-abc123' },
    },
    null,
    2,
  ),
  log: [
    '2025-01-15T10:23:44.123Z INFO  [server] Starting HTTP server on :8080',
    '2025-01-15T10:23:44.456Z INFO  [db] Connected to PostgreSQL at localhost:5432',
    '2025-01-15T10:23:45.001Z INFO  [server] Request: GET /api/users 200 12ms',
    '2025-01-15T10:23:45.102Z INFO  [server] Request: POST /api/users 201 34ms',
    '2025-01-15T10:23:45.204Z WARN  [auth] Token expiring soon for user alice@example.com',
    '2025-01-15T10:23:45.305Z INFO  [server] Request: GET /api/users/1 200 8ms',
    '2025-01-15T10:23:45.407Z INFO  [db] Query executed in 5ms: SELECT * FROM users WHERE id=1',
    '2025-01-15T10:23:45.509Z INFO  [server] Request: DELETE /api/sessions/tok-xyz 204 3ms',
    '2025-01-15T10:23:45.611Z INFO  [server] Request: GET /api/health 200 1ms',
    '2025-01-15T10:23:45.712Z INFO  [server] Request: GET /api/users 200 11ms',
    '2025-01-15T10:23:45.814Z ERROR [db] Slow query detected (>100ms): SELECT * FROM audit_log',
    '2025-01-15T10:23:45.916Z INFO  [server] Request: GET /api/users/2 200 9ms',
    '2025-01-15T10:23:46.018Z INFO  [cache] Cache miss for key: users:page:1',
    '2025-01-15T10:23:46.120Z INFO  [db] Query executed in 18ms: SELECT * FROM users LIMIT 20',
    '2025-01-15T10:23:46.221Z INFO  [cache] Cache updated for key: users:page:1 (TTL: 60s)',
  ].join('\n'),
  lorem:
    'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.\n\nSed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque laudantium, totam rem aperiam, eaque ipsa quae ab illo inventore veritatis et quasi architecto beatae vitae dicta sunt explicabo. Nemo enim ipsam voluptatem quia voluptas sit aspernatur aut odit aut fugit, sed quia consequuntur magni dolores eos qui ratione voluptatem sequi nesciunt. Neque porro quisquam est, qui dolorem ipsum quia dolor sit amet, consectetur, adipisci velit.\n\nAt vero eos et accusamus et iusto odio dignissimos ducimus qui blanditiis praesentium voluptatum deleniti atque corrupti quos dolores et quas molestias excepturi sint occaecati cupiditate non provident, similique sunt in culpa qui officia deserunt mollitia animi, id est laborum et dolorum fuga.',
};

// --- Algorithm configuration ---
const ALGOS = {
  zstd: {
    label: 'zstd',
    color: 'blue',
    levelMin: 1,
    levelMax: 22,
    levelDefault: 3,
    levelHint: '1 = fast, 22 = best ratio',
    ext: '.zst',
  },
  gzip: {
    label: 'gzip',
    color: 'green',
    levelMin: 0,
    levelMax: 9,
    levelDefault: 6,
    levelHint: '0 = no compression, 9 = best ratio',
    ext: '.gz',
  },
  brotli: {
    label: 'brotli',
    color: 'amber',
    levelMin: 0,
    levelMax: 11,
    levelDefault: 6,
    levelHint: '0 = fast, 11 = best ratio',
    ext: '.br',
  },
  lz4: {
    label: 'lz4',
    color: 'pink',
    levelMin: null,
    levelMax: null,
    levelDefault: null,
    levelHint: null,
    ext: '.lz4',
  },
};

// --- State ---
let currentAlgo = 'zstd';
let currentLevel = ALGOS.zstd.levelDefault;
let currentInput = new Uint8Array(0);
let currentCompressed = null; // { bytes, ext } of the latest result shown
let currentFileName = 'input';
let compareTimer = null;
let busyTimer = null;
let compressSeq = 0;
let compareSeq = 0;

// --- DOM refs ---
const inputText = document.getElementById('input-text');
const inputSizeEl = document.getElementById('input-size');
const algoBtns = document.querySelectorAll('.algo-btn');
const levelRow = document.getElementById('level-row');
const levelSlider = document.getElementById('level-slider');
const levelDisplay = document.getElementById('level-display');
const levelHint = document.getElementById('level-hint');
const originalSizeEl = document.getElementById('original-size');
const compressedSizeEl = document.getElementById('compressed-size');
const compressionRatioEl = document.getElementById('compression-ratio');
const compressTimeEl = document.getElementById('compress-time');
const downloadBtn = document.getElementById('download-btn');
const downloadExtEl = document.getElementById('download-ext');
const compareTable = document.getElementById('compare-table');
const loadingOverlay = document.getElementById('loading-overlay');
const sampleBtns = document.querySelectorAll('.sample-btn');
const fileInput = document.getElementById('file-input');
const fileError = document.getElementById('file-error');

// --- Utilities ---
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatTime(ms) {
  if (ms < 1) return `${(ms * 1000).toFixed(0)} µs`;
  if (ms < 1000) return `${ms.toFixed(1)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

// --- Compression worker ---
// The compressors run in worker.js, so that large inputs and high levels do
// not freeze the page. A request cannot be stopped once the worker has it, so
// the page sends one at a time and keeps only the latest waiting request of
// each kind: the selected algorithm ('compress') goes before the comparison
// table ('compare'). A request superseded while it waits resolves to null.
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
const REQUEST_KINDS = ['compress', 'compare'];
const waiting = new Map();
let workerReady = false;
let inFlight = null;

/** Compress `input` once per { algo, level } of `runs`, in the worker. */
function runInWorker(kind, input, runs) {
  waiting.get(kind)?.resolve(null);
  return new Promise((resolve) => {
    waiting.set(kind, { input, runs, resolve });
    sendNextRequest();
  });
}

function sendNextRequest() {
  const kind = REQUEST_KINDS.find((k) => waiting.has(k));
  if (!workerReady || inFlight || !kind) return;
  const { input, runs, resolve } = waiting.get(kind);
  waiting.delete(kind);
  inFlight = resolve;
  worker.postMessage({ input, runs });
}

worker.addEventListener('message', ({ data }) => {
  if (data.ready) {
    workerReady = true;
    onWorkerReady();
  } else {
    const resolve = inFlight;
    inFlight = null;
    resolve(data.results);
  }
  sendNextRequest();
});
worker.addEventListener('error', (event) => onWorkerError(event.message));

// --- Algorithm selector ---
function setAlgo(algo) {
  currentAlgo = algo;
  const cfg = ALGOS[algo];

  for (const btn of algoBtns) {
    btn.classList.toggle('active', btn.dataset.algo === algo);
    btn.setAttribute('data-color', btn.dataset.algo === algo ? ALGOS[btn.dataset.algo].color : '');
  }

  if (cfg.levelMin !== null) {
    levelRow.hidden = false;
    levelSlider.min = cfg.levelMin;
    levelSlider.max = cfg.levelMax;
    currentLevel = cfg.levelDefault;
    levelSlider.value = currentLevel;
    levelDisplay.textContent = currentLevel;
    levelHint.textContent = cfg.levelHint;
  } else {
    levelRow.hidden = true;
  }

  downloadExtEl.textContent = cfg.ext;

  void compress();
}

// --- Compress ---
// Callers start compress() without waiting for it, with `void`: it never
// rejects, as the worker answers a failed run with its error, and the
// latest call alone shows its result.
async function compress() {
  const seq = ++compressSeq;
  clearTimeout(busyTimer);

  if (currentInput.length === 0) {
    originalSizeEl.textContent = '—';
    compressedSizeEl.textContent = '—';
    compressionRatioEl.textContent = '';
    compressTimeEl.textContent = '';
    downloadBtn.hidden = true;
    currentCompressed = null;
    scheduleCompare();
    return;
  }

  const input = currentInput;
  const cfg = ALGOS[currentAlgo];
  const level = cfg.levelMin !== null ? currentLevel : undefined;
  busyTimer = setTimeout(() => {
    compressTimeEl.textContent = 'Compressing\u2026';
  }, 100);
  const results = await runInWorker('compress', input, [{ algo: currentAlgo, level }]);
  // Show only the result of the latest call.
  if (seq !== compressSeq) return;
  clearTimeout(busyTimer);

  const [{ compressed, elapsed, error }] = results;
  if (error === undefined) {
    currentCompressed = { bytes: compressed, ext: cfg.ext };

    const ratio = (1 - compressed.length / input.length) * 100;

    originalSizeEl.textContent = formatBytes(input.length);
    compressedSizeEl.textContent = formatBytes(compressed.length);
    if (ratio >= 0) {
      compressionRatioEl.textContent = `${ratio.toFixed(1)}% smaller`;
      compressionRatioEl.classList.remove('is-expanded');
    } else {
      compressionRatioEl.textContent = `${(-ratio).toFixed(1)}% larger`;
      compressionRatioEl.classList.add('is-expanded');
    }
    compressTimeEl.textContent = formatTime(elapsed);
    downloadBtn.hidden = false;
  } else {
    compressedSizeEl.textContent = 'Error';
    compressionRatioEl.textContent = error;
    compressTimeEl.textContent = '';
    downloadBtn.hidden = true;
    currentCompressed = null;
  }

  scheduleCompare();
}

// --- Compare (debounced) ---
function scheduleCompare() {
  clearTimeout(compareTimer);
  compareTimer = setTimeout(runCompare, 200);
}

async function runCompare() {
  const seq = ++compareSeq;

  if (currentInput.length === 0) {
    compareTable.innerHTML =
      '<div class="compare-placeholder">Enter some text above to see comparisons.</div>';
    return;
  }

  const input = currentInput;
  const algos = Object.entries(ALGOS);
  const runs = algos.map(([algo, cfg]) => ({ algo, level: cfg.levelDefault ?? undefined }));
  const outcomes = await runInWorker('compare', input, runs);
  if (seq !== compareSeq) return;

  const results = algos.map(([key, cfg], i) => {
    const { compressed, elapsed, error } = outcomes[i];
    if (error !== undefined) {
      return { key, cfg, compressed: null, elapsed: 0, ratio: 0, error: true };
    }
    const ratio = (1 - compressed.length / input.length) * 100;
    return { key, cfg, compressed, elapsed, ratio };
  });

  const maxRatio = Math.max(...results.map((r) => r.ratio));
  const fastestIdx = results.reduce(
    (minIdx, r, idx, arr) => (r.elapsed < arr[minIdx].elapsed ? idx : minIdx),
    0,
  );
  const fastestKey = results[fastestIdx].key;

  const rows = results
    .map((r) => {
      if (r.error) {
        return `<div class="compare-row">
          <span class="compare-algo compare-algo--${r.cfg.color}">${r.cfg.label}</span>
          <span class="compare-error">Error</span>
        </div>`;
      }

      const barPct = Math.max(0, Math.min(100, r.ratio));
      const isBest = r.ratio === maxRatio;
      const isFastest = r.key === fastestKey;
      const levelLabel = r.cfg.levelMin !== null ? ` L${r.cfg.levelDefault}` : '';

      let badge;
      if (isBest) {
        badge = '<span class="compare-badge compare-badge--best">best</span>';
      } else if (isFastest) {
        badge = '<span class="compare-badge compare-badge--fastest">fastest</span>';
      } else {
        badge = '<span class="compare-badge"></span>';
      }

      return `<div class="compare-row ${currentAlgo === r.key ? 'compare-row--active' : ''}">
        <span class="compare-algo compare-algo--${r.cfg.color}">${r.cfg.label}${levelLabel}</span>
        <div class="compare-bar-wrap">
          <div class="compare-bar compare-bar--${r.cfg.color}" style="width:${barPct}%"></div>
        </div>
        <span class="compare-ratio">${r.ratio.toFixed(1)}%</span>
        <span class="compare-size">${formatBytes(r.compressed.length)}</span>
        <span class="compare-time">${formatTime(r.elapsed)}</span>
        ${badge}
      </div>`;
    })
    .join('');

  compareTable.innerHTML = `
    <div class="compare-header">
      <span>Algorithm</span>
      <span>Savings</span>
      <span>Saved</span>
      <span>Size</span>
      <span>Time</span>
      <span></span>
    </div>
    ${rows}
    <div class="compare-note">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      Default levels shown. Adjust level in Compress above to tune ratio vs. speed.
    </div>`;
}

// --- Input handling ---
function onInputChange() {
  const text = inputText.value;
  currentInput = new TextEncoder().encode(text);
  currentFileName = 'input';
  inputSizeEl.textContent = formatBytes(currentInput.length);
  void compress();
}

// --- Sample data ---
for (const btn of sampleBtns) {
  btn.addEventListener('click', () => {
    for (const b of sampleBtns) {
      b.classList.remove('active');
    }
    btn.classList.add('active');
    inputText.value = SAMPLES[btn.dataset.sample];
    inputText.setSelectionRange(0, 0);
    inputText.scrollTop = 0;
    onInputChange();
  });
}

// --- File upload ---
fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;

  if (file.size > 10 * 1024 * 1024) {
    fileError.textContent = 'File exceeds the 10 MB limit. Please use a smaller file.';
    fileError.hidden = false;
    setTimeout(() => {
      fileError.hidden = true;
    }, 5000);
    fileInput.value = '';
    return;
  }

  for (const b of sampleBtns) {
    b.classList.remove('active');
  }
  currentFileName = file.name;

  const reader = new FileReader();
  reader.onerror = () => {
    fileError.textContent = 'Failed to read the file. Please try again.';
    fileError.hidden = false;
    setTimeout(() => {
      fileError.hidden = true;
    }, 5000);
    fileInput.value = '';
  };
  reader.onload = (ev) => {
    const bytes = new Uint8Array(ev.target.result);
    currentInput = bytes;

    if (file.type.startsWith('text/') || file.name.endsWith('.json') || file.name.endsWith('.md')) {
      inputText.value = new TextDecoder().decode(bytes);
    } else {
      inputText.value = `[Binary file: ${file.name} — ${formatBytes(file.size)}]`;
    }

    inputSizeEl.textContent = formatBytes(currentInput.length);
    void compress();
  };
  reader.readAsArrayBuffer(file);
});

// --- Algorithm buttons ---
for (const btn of algoBtns) {
  btn.addEventListener('click', () => setAlgo(btn.dataset.algo));
}

// --- Level slider ---
levelSlider.addEventListener('input', () => {
  currentLevel = Number(levelSlider.value);
  levelDisplay.textContent = currentLevel;
  void compress();
});

// --- Download ---
downloadBtn.addEventListener('click', () => {
  if (!currentCompressed) return;
  const blob = new Blob([currentCompressed.bytes], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${currentFileName}${currentCompressed.ext}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

// --- Input event ---
inputText.addEventListener('input', onInputChange);

// --- Init ---
const loadingText = loadingOverlay.querySelector('.loading-text');

function onWorkerReady() {
  loadingOverlay.classList.add('hidden');

  // Load JSON sample by default
  inputText.value = SAMPLES.json;
  onInputChange();
  setAlgo('zstd');

  // Focus and position cursor at start (prevents auto-scroll to end)
  inputText.focus();
  inputText.setSelectionRange(0, 0);
  inputText.scrollTop = 0;
}

function onWorkerError(message) {
  const detail = message ? ` (${message})` : '';
  loadingText.textContent = `Failed to load the WebAssembly module${detail}. Try reloading, or use a recent version of Chrome, Edge, Firefox, or Safari.`;
  loadingOverlay.classList.remove('hidden');
  if (!loadingText.nextElementSibling) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Reload';
    btn.className = 'loading-reload-btn';
    btn.addEventListener('click', () => location.reload());
    loadingText.after(btn);
  }
}

// Earlier versions of the playground registered coi-serviceworker.js for
// cross-origin isolation, which the WebAssembly build does not need.
// Unregister it for returning visitors, so that it stops intercepting
// requests. Other service workers of the origin are left alone.
const staleWorkerUrl = new URL(`${import.meta.env.BASE_URL}coi-serviceworker.js`, location.origin)
  .href;
navigator.serviceWorker
  ?.getRegistrations()
  .then((registrations) => {
    for (const registration of registrations) {
      const sw = registration.active ?? registration.waiting ?? registration.installing;
      if (sw?.scriptURL === staleWorkerUrl) registration.unregister();
    }
  })
  // Service workers can be unavailable, as in some private windows.
  .catch(() => {});
