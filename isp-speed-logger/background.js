// ISP Speed Logger - background service worker
const TEST_MS = 10000;     // how long the download and upload phases each run
const WARMUP_MS = 2000;    // ignored at the start of each phase (TCP slow start)
const SERVERS = [
  { name: 'Amsterdam, NL (Clouvider)', base: 'https://ams.speedtest.clouvider.net/backend', down: 'garbage.php', up: 'empty.php', ping: 'empty.php', ip: 'getIP.php' },
  { name: 'Frankfurt, DE (Clouvider)', base: 'https://fra.speedtest.clouvider.net/backend', down: 'garbage.php', up: 'empty.php', ping: 'empty.php', ip: 'getIP.php' },
];
const MAX_LOG = 5000;      // max rows kept locally
const DEFAULTS = { intervalMin: 30, label: '', webhookUrl: '', token: '' };

let running = false;

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULTS, ...settings };
}

async function schedule() {
  const s = await getSettings();
  await chrome.alarms.clear('speedtest');
  chrome.alarms.create('speedtest', {
    delayInMinutes: 1,
    periodInMinutes: Math.max(1, Number(s.intervalMin) || 30),
  });
}

chrome.runtime.onInstalled.addListener(schedule);
chrome.runtime.onStartup.addListener(schedule);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) schedule();
});
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'speedtest') runTest(); });
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'runNow') {
    runTest().then(() => sendResponse({ done: true }));
    return true;
  }
});

// ---------- measurements ----------
// Backend: public LibreSpeed servers (open source, not Cloudflare). Tried in order.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function randomBuffer(n) {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(b.subarray(i, Math.min(i + 65536, n)));
  return b;
}

async function pickServer() {
  for (const s of SERVERS) {
    try {
      const r = await fetch(`${s.base}/${s.ip}?r=${Math.random()}`, { cache: 'no-store', signal: AbortSignal.timeout(6000) });
      if (!r.ok) continue;
      let txt = (await r.text()).trim();
      try { const j = JSON.parse(txt); txt = j.processedString || j.ip || txt; } catch (_) { /* plain text */ }
      return { ...s, ipAddr: txt.split(' ')[0] };
    } catch (_) { /* try next server */ }
  }
  throw new Error('no speed test server reachable');
}

async function measurePing(s, n = 10) {
  const times = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    const r = await fetch(`${s.base}/${s.ping}?r=${Math.random()}`, { cache: 'no-store' });
    await r.arrayBuffer();
    times.push(performance.now() - t0);
  }
  times.shift(); // first request includes TLS handshake
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)];
}

// Bytes are only counted after a warm-up period so TCP slow start does not drag the result down.
async function measureDownload(s, ms = TEST_MS, streams = 4) {
  const ctrl = new AbortController();
  const t0 = performance.now();
  const warmEnd = t0 + WARMUP_MS;
  let bytes = 0;
  const timer = setTimeout(() => ctrl.abort(), ms);
  await Promise.allSettled(Array.from({ length: streams }, async () => {
    while (!ctrl.signal.aborted) {
      const r = await fetch(`${s.base}/${s.down}?ckSize=100&r=${Math.random()}`, { cache: 'no-store', signal: ctrl.signal });
      const reader = r.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (performance.now() >= warmEnd) bytes += value.length;
      }
    }
  }));
  clearTimeout(timer);
  const end = performance.now();
  if (bytes === 0) throw new Error('download failed');
  return (bytes * 8) / ((end - warmEnd) / 1000) / 1e6;
}

// Upload: fetch() cannot report upload progress, so we send POSTs whose size adapts to the line
// (~1 s each) and credit each request's bytes proportionally to how much of it overlapped the
// measurement window [warm-up end, deadline]. This avoids the old bias from tiny fixed 500 KB
// requests (round-trip overhead, slow start, and requests finishing after the clock stopped).
async function measureUpload(s, ms = TEST_MS, streams = 4) {
  const MIN = 64_000, MAX = 25_000_000;
  const buf = randomBuffer(MAX);
  const ctrl = new AbortController();
  const t0 = performance.now();
  const w0 = t0 + WARMUP_MS;
  const w1 = t0 + ms;
  const hardStop = setTimeout(() => ctrl.abort(), ms + 5000);
  const recs = [];
  let size = 128_000;
  await Promise.allSettled(Array.from({ length: streams }, async () => {
    while (performance.now() < w1 && !ctrl.signal.aborted) {
      const n = size;
      const a = performance.now();
      const r = await fetch(`${s.base}/${s.up}`, {
        method: 'POST', body: buf.subarray(0, n), cache: 'no-store', signal: ctrl.signal,
      });
      await r.arrayBuffer();
      const b = performance.now();
      recs.push({ a, b, n });
      const sec = Math.max(0.01, (b - a) / 1000);
      size = clamp(Math.round(n * clamp(1 / sec, 0.5, 2)), MIN, MAX); // aim for ~1 s per request
    }
  }));
  clearTimeout(hardStop);
  let credited = 0;
  for (const { a, b, n } of recs) {
    const overlap = Math.min(b, w1) - Math.max(a, w0);
    if (overlap > 0) credited += n * (overlap / (b - a));
  }
  if (credited === 0) throw new Error('upload failed');
  return (credited * 8) / ((w1 - w0) / 1000) / 1e6;
}

// ---------- logging ----------

async function flushPending() {
  const s = await getSettings();
  if (!s.webhookUrl) return;
  let { pending = [] } = await chrome.storage.local.get('pending');
  while (pending.length) {
    try {
      const r = await fetch(s.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // avoids CORS preflight
        body: JSON.stringify({ token: s.token, ...pending[0] }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'rejected');
      pending.shift();
    } catch (e) {
      break; // offline or error: keep the rest and retry on the next run
    }
  }
  await chrome.storage.local.set({ pending });
}

async function runTest() {
  if (running) return;
  running = true;
  await chrome.storage.local.set({ running: true });
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
  const s = await getSettings();
  const row = {
    time: new Date().toISOString(), label: s.label, ip: '', server: '',
    down: null, up: null, ping: null, status: 'ok',
  };
  try {
    const srv = await pickServer();
    row.ip = srv.ipAddr; row.server = srv.name;
    row.ping = +(await measurePing(srv)).toFixed(1);
    row.down = +(await measureDownload(srv)).toFixed(2);
    row.up = +(await measureUpload(srv)).toFixed(2);
  } catch (e) {
    row.status = 'error: ' + (e.message || e);
  }
  clearInterval(keepAlive);

  const { log = [], pending = [] } = await chrome.storage.local.get(['log', 'pending']);
  log.push(row);
  if (log.length > MAX_LOG) log.splice(0, log.length - MAX_LOG);
  if (s.webhookUrl) pending.push(row);
  await chrome.storage.local.set({ log, pending });
  await flushPending();

  running = false;
  await chrome.storage.local.set({ running: false });
}
