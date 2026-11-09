// ISP Speed Logger - background service worker
const TEST_MS = 10000;     // how long the download and upload phases each run
const WARMUP_MS = 2000;    // ignored at the start of each phase (TCP slow start)
const SERVERS = [
  { name: 'Amsterdam, NL (Clouvider)', base: 'https://ams.speedtest.clouvider.net/backend', down: 'garbage.php', up: 'empty.php', ping: 'empty.php', ip: 'getIP.php' },
  { name: 'Frankfurt, DE (Clouvider)', base: 'https://fra.speedtest.clouvider.net/backend', down: 'garbage.php', up: 'empty.php', ping: 'empty.php', ip: 'getIP.php' },
];
const MAX_LOG = 5000;      // max rows kept locally
const DEFAULTS = { intervalMin: 30, label: '', webhookUrl: '', token: '', routerOn: true, routerUrl: '', lanUrl: '' };

// Common default-gateway addresses, in priority order, probed to auto-detect the router.
const ROUTER_CANDIDATES = [
  '192.168.0.1', '192.168.1.1', '192.168.1.254', '192.168.0.254', '10.0.0.1', '192.168.2.1', '10.0.1.1',
  '192.168.10.1', '192.168.100.1', '192.168.178.1', '192.168.8.1', '192.168.50.1', '192.168.88.1',
  '192.168.3.1', '192.168.15.1', '192.168.123.1', '10.10.10.1', '172.16.0.1',
];

// Overall progress bar layout (percent of the bar each phase fills)
const PHASES_WAN = {
  prepare:  { from: 0,  to: 12 },
  download: { from: 12, to: 56 },
  upload:   { from: 56, to: 100 },
};
// With a LAN test server configured, the LAN phases run first and the bar is re-divided.
const PHASES_LAN = {
  prepare:        { from: 0,  to: 8 },
  'lan-download': { from: 8,  to: 22 },
  'lan-upload':   { from: 22, to: 36 },
  download:       { from: 36, to: 68 },
  upload:         { from: 68, to: 100 },
};
let PHASES = PHASES_WAN;
const LAN_MS = 5000;       // LAN download / upload phase length
const LAN_WARMUP_MS = 1000;

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
  if (msg.type === 'detectRouter') {
    detectRouter(true).then((url) => sendResponse({ url }));
    return true;
  }
});

// ---------- live progress (read by the popup) ----------

const prog = {};
let lastPush = 0;

function push(patch, force = false) {
  Object.assign(prog, patch);
  const now = Date.now();
  if (!force && now - lastPush < 200) return; // throttle storage writes
  lastPush = now;
  try { chrome.storage.session.set({ progress: { ...prog } }).catch(() => {}); } catch (_) { /* no session storage */ }
}

function phasePct(phase, frac) {
  const p = PHASES[phase];
  return p.from + (p.to - p.from) * clamp(frac, 0, 1);
}

// ---------- helpers ----------

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

function randomBuffer(n) {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(b.subarray(i, Math.min(i + 65536, n)));
  return b;
}

// ---------- WAN measurements ----------
// Backend: public LibreSpeed servers (open source). Tried in order.

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
    if (i > 0) push({ ping: median(times.slice(1)) }); // first request includes TLS handshake
  }
  times.shift();
  return median(times);
}

// Bytes are only counted after a warm-up period so TCP slow start does not drag the final result down.
// The live value is the rate over the last second.
async function measureDownload(s, { ms = TEST_MS, warm = WARMUP_MS, streams = 4, phase = 'download', key = 'down', ckSize = 100 } = {}) {
  const ctrl = new AbortController();
  const t0 = performance.now();
  const warmEnd = t0 + warm;
  let bytes = 0, total = 0;
  const hist = [[t0, 0]];
  const ticker = setInterval(() => {
    const now = performance.now();
    hist.push([now, total]);
    const ref = hist.find(([t]) => t >= now - 1000) || hist[0];
    const dt = (now - ref[0]) / 1000;
    const live = dt > 0 ? ((total - ref[1]) * 8) / dt / 1e6 : null;
    push({ phase, pct: phasePct(phase, (now - t0) / ms), phaseMs: now - t0, phaseTotalMs: ms, live, [key]: live });
  }, 250);
  const timer = setTimeout(() => ctrl.abort(), ms);
  await Promise.allSettled(Array.from({ length: streams }, async () => {
    while (!ctrl.signal.aborted) {
      const r = await fetch(`${s.base}/${s.down}?ckSize=${ckSize}&r=${Math.random()}`, { cache: 'no-store', signal: ctrl.signal });
      const reader = r.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (performance.now() >= warmEnd) bytes += value.length;
      }
    }
  }));
  clearTimeout(timer);
  clearInterval(ticker);
  const end = performance.now();
  if (bytes === 0) throw new Error('download failed');
  return (bytes * 8) / ((end - warmEnd) / 1000) / 1e6;
}

// Upload: fetch() cannot report upload progress, so we send POSTs whose size adapts to the line
// (~1 s each) and credit each request's bytes proportionally to how much of it overlapped the
// measurement window [warm-up end, deadline]. This avoids the bias of tiny fixed-size requests
// (round-trip overhead, slow start, and requests finishing after the clock stopped).
function creditedBytes(recs, from, to) {
  let credited = 0;
  for (const { a, b, n } of recs) {
    const overlap = Math.min(b, to) - Math.max(a, from);
    if (overlap > 0) credited += n * (overlap / Math.max(1, b - a));
  }
  return credited;
}

const UP_MIN = 64_000, UP_MAX = 25_000_000;

async function measureUpload(s, buf, { ms = TEST_MS, warm = WARMUP_MS, streams = 4, phase = 'upload', key = 'up' } = {}) {
  const MIN = UP_MIN, MAX = UP_MAX;
  const ctrl = new AbortController();
  const t0 = performance.now();
  const w0 = t0 + warm;
  const w1 = t0 + ms;
  const hardStop = setTimeout(() => ctrl.abort(), ms + 5000);
  const recs = [];
  let size = 128_000;
  const ticker = setInterval(() => {
    const now = Math.min(performance.now(), w1);
    const from = Math.max(t0, now - 2000);
    const live = now > from ? (creditedBytes(recs, from, now) * 8) / ((now - from) / 1000) / 1e6 : null;
    push({ phase, pct: phasePct(phase, (performance.now() - t0) / ms),
           phaseMs: Math.min(performance.now() - t0, ms), phaseTotalMs: ms, live, [key]: live });
  }, 250);
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
  clearInterval(ticker);
  const credited = creditedBytes(recs, w0, w1);
  if (credited === 0) throw new Error('upload failed');
  return (credited * 8) / ((w1 - w0) / 1000) / 1e6;
}

// ---------- LAN measurement ----------
// Same measurement code as the WAN test, pointed at the LAN speed server (lan-server/server.js)
// running on another device in the home network. Shows what the home network itself can carry.

function normalizeLanUrl(u) {
  u = (u || '').trim().replace(/\/+$/, '');
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
  if (!/:\d+$/.test(u.replace(/^https?:\/\//i, ''))) u += ':8787';
  return u;
}

async function measureLan(base, uploadBuf, monitor) {
  const lan = { base, down: 'garbage.php', up: 'empty.php', ping: 'empty.php', ip: 'getIP.php' };
  const out = { lanDown: null, lanUp: null, lanPing: null };
  const r = await fetch(`${base}/${lan.ip}?r=${Math.random()}`, { cache: 'no-store', signal: AbortSignal.timeout(2500) });
  if (!r.ok) throw new Error('LAN server answered with an error');
  monitor?.setPhase('lan');
  out.lanPing = +(await measurePing(lan, 8)).toFixed(1);
  push({ lanPing: out.lanPing });
  out.lanDown = +(await measureDownload(lan, { ms: LAN_MS, warm: LAN_WARMUP_MS, phase: 'lan-download', key: 'lanDown', ckSize: 200 })).toFixed(1);
  push({ lanDown: out.lanDown, live: null }, true);
  out.lanUp = +(await measureUpload(lan, uploadBuf, { ms: LAN_MS, warm: LAN_WARMUP_MS, phase: 'lan-upload', key: 'lanUp' })).toFixed(1);
  push({ lanUp: out.lanUp, live: null }, true);
  return out;
}

// ---------- router (home network) monitor ----------
// Routers do not host a speed test server, so we measure what matters for telling "home network"
// from "WAN": round-trip time and packet loss to the router, sampled ~4x/second for the whole run.
// If the router stays fast and loss-free while the WAN test saturates the line, the home network
// is fine; if its latency spikes or requests time out, the Wi-Fi/LAN (or router) is the problem.

function normalizeRouterUrl(u) {
  u = (u || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
  return u;
}

async function routerProbe(url, timeoutMs = 2000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = performance.now();
  try {
    const sep = url.includes('?') ? '&' : '?';
    // no-cors: we only need the timing, not the (opaque) response, so no host permission is required
    const r = await fetch(`${url}${sep}r=${Math.random()}`, { cache: 'no-store', mode: 'no-cors', signal: ctrl.signal });
    const ms = performance.now() - t0; // time until response headers
    try { await r.body?.cancel(); } catch (_) { /* ignore */ }
    return ms;
  } catch (_) {
    return null; // timeout or unreachable
  } finally {
    clearTimeout(timer);
  }
}

// Find the router by probing the usual gateway addresses in parallel. Chrome extensions cannot read
// the OS routing table, so this is a heuristic: the first candidate (in priority order) that answers
// an HTTP request wins. The result is cached; it is cleared when the router stops answering.
async function detectRouter(force = false) {
  if (!force) {
    const { routerCache } = await chrome.storage.local.get('routerCache');
    if (routerCache?.url) return routerCache.url;
  }
  const probes = ROUTER_CANDIDATES.map((ip) => routerProbe(`http://${ip}/`, 1500));
  for (let i = 0; i < probes.length; i++) {
    if ((await probes[i]) !== null) {
      const url = `http://${ROUTER_CANDIDATES[i]}/`;
      await chrome.storage.local.set({ routerCache: { url, at: Date.now() } });
      return url;
    }
  }
  await chrome.storage.local.remove('routerCache');
  return '';
}

function startRouterMonitor(url) {
  const samples = []; // { phase, rtt|null }
  let phase = 'idle';
  let stop = false;
  let consecutiveFails = 0;
  let first = true;
  const done = (async () => {
    while (!stop) {
      const t0 = performance.now();
      const rtt = await routerProbe(url);
      if (first) { first = false; if (rtt !== null) { await sleep(100); continue; } } // first one pays TCP setup
      samples.push({ phase, rtt });
      consecutiveFails = rtt === null ? consecutiveFails + 1 : 0;
      push({ router: rtt, routerPhase: phase });
      if (samples.length <= 4 && consecutiveFails >= 3) break; // unreachable: give up early
      await sleep(Math.max(0, 250 - (performance.now() - t0)));
    }
  })();
  return {
    setPhase(p) { phase = p; },
    async finish() { stop = true; await done; return summarizeRouter(samples); },
  };
}

function summarizeRouter(samples) {
  const ok = (p) => samples.filter((s) => s.phase === p && s.rtt !== null).map((s) => s.rtt);
  const idle = ok('idle');
  const down = ok('download');
  const up = ok('upload');
  const lanS = ok('lan');
  const loaded = samples.filter((s) => s.phase !== 'idle');
  const allOk = [...idle, ...down, ...up, ...lanS];
  const r1 = (v) => (v === null ? null : +v.toFixed(1));
  if (!allOk.length) {
    return { routerIdle: null, routerDown: null, routerUp: null, routerLan: null, routerMax: null, routerLoss: null, routerStatus: 'unreachable' };
  }
  const lossBase = loaded.length ? loaded : samples;
  const loss = (lossBase.filter((s) => s.rtt === null).length / lossBase.length) * 100;
  const idleMed = median(idle);
  const loadedAvg = Math.max(mean(down) ?? 0, mean(up) ?? 0);
  const degraded = loss >= 2 || (idleMed !== null && loadedAvg > idleMed + 50);
  return {
    routerIdle: r1(idleMed),
    routerDown: r1(mean(down)),
    routerUp: r1(mean(up)),
    routerLan: r1(mean(lanS)),
    routerMax: r1(Math.max(...[...down, ...up, ...idle, ...lanS])),
    routerLoss: +loss.toFixed(1),
    routerStatus: degraded ? 'degraded' : 'ok',
  };
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
  for (const k of Object.keys(prog)) delete prog[k];
  push({ phase: 'prepare', pct: 2, startedAt: Date.now(), down: null, up: null, ping: null, router: null, live: null }, true);
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
  const s = await getSettings();
  const row = {
    time: new Date().toISOString(), label: s.label, ip: '', server: '',
    down: null, up: null, ping: null, status: 'ok',
    routerIdle: null, routerDown: null, routerUp: null, routerLan: null, routerMax: null, routerLoss: null, routerStatus: 'off', routerAddr: '',
    lanStatus: 'off', lanServer: '', lanDown: null, lanUp: null, lanPing: null,
  };
  const lanBase = normalizeLanUrl(s.lanUrl);
  PHASES = lanBase ? PHASES_LAN : PHASES_WAN;

  // Build the upload payload up front: generating 25 MB of random data stalls the worker for a moment,
  // which would otherwise show up as a fake latency spike in the router samples.
  const uploadBuf = randomBuffer(UP_MAX);

  // Start the router monitor first so it samples the idle baseline, then runs alongside the WAN test.
  let routerUrl = '';
  let monitor = null;
  const manualRouter = normalizeRouterUrl(s.routerUrl);
  if (s.routerOn !== false) {
    push({ phase: 'prepare', pct: 3, detecting: !manualRouter }, true);
    routerUrl = manualRouter || await detectRouter();
    if (routerUrl) {
      monitor = startRouterMonitor(routerUrl);
      row.routerAddr = new URL(routerUrl).hostname;
    } else {
      row.routerStatus = 'not found';
    }
  }
  push({ routerEnabled: !!monitor, routerUrl: monitor ? routerUrl : '', detecting: false, lanEnabled: !!lanBase,
         lanDown: null, lanUp: null, lanPing: null }, true);

  // LAN test first, so it runs on a quiet line and the WAN numbers are not disturbed by it.
  if (lanBase) {
    row.lanServer = new URL(lanBase).host;
    try {
      Object.assign(row, await measureLan(lanBase, uploadBuf, monitor));
      row.lanStatus = 'ok';
    } catch (e) {
      row.lanStatus = 'unreachable';
      push({ lanFailed: true }, true);
    }
    monitor?.setPhase('idle');
  }

  try {
    push({ phase: 'prepare', pct: lanBase ? PHASES.download.from : 4 }, true);
    const srv = await pickServer();
    row.ip = srv.ipAddr; row.server = srv.name;
    push({ pct: lanBase ? PHASES.download.from : 8, server: srv.name, ip: srv.ipAddr }, true);
    row.ping = +(await measurePing(srv)).toFixed(1);
    push({ ping: row.ping, pct: PHASES.download.from }, true);

    monitor?.setPhase('download');
    row.down = +(await measureDownload(srv)).toFixed(2);
    push({ down: row.down, live: null, pct: PHASES.upload.from }, true);

    monitor?.setPhase('upload');
    row.up = +(await measureUpload(srv, uploadBuf)).toFixed(2);
    push({ up: row.up, live: null, pct: 100 }, true);
  } catch (e) {
    row.status = 'error: ' + (e.message || e);
  }
  clearInterval(keepAlive);
  if (monitor) {
    Object.assign(row, await monitor.finish());
    // An auto-detected router that no longer answers (e.g. you changed network): forget it and re-detect next run.
    if (row.routerStatus === 'unreachable' && !manualRouter) await chrome.storage.local.remove('routerCache');
  }

  const { log = [], pending = [] } = await chrome.storage.local.get(['log', 'pending']);
  log.push(row);
  if (log.length > MAX_LOG) log.splice(0, log.length - MAX_LOG);
  if (s.webhookUrl) pending.push(row);
  await chrome.storage.local.set({ log, pending });
  await flushPending();

  running = false;
  try { await chrome.storage.session.remove('progress'); } catch (_) { /* ignore */ }
  await chrome.storage.local.set({ running: false });
}
