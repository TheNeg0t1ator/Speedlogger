const $ = (id) => document.getElementById(id);
const DEFAULTS = { intervalMin: 30, label: '', webhookUrl: '', token: '', routerOn: true, routerUrl: '' };

// ---------- theme ----------
const media = window.matchMedia('(prefers-color-scheme: dark)');
let themePref = null; // 'light' | 'dark' | null (follow system)

function applyTheme() {
  document.documentElement.dataset.theme = themePref || (media.matches ? 'dark' : 'light');
}
applyTheme(); // immediate, avoids a flash while storage loads
media.addEventListener('change', applyTheme);

$('theme').onclick = async () => {
  themePref = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme();
  await chrome.storage.local.set({ theme: themePref });
};

// ---------- settings ----------
let settings = { ...DEFAULTS };

async function loadSettings() {
  const { settings: saved, theme } = await chrome.storage.local.get(['settings', 'theme']);
  if (theme) { themePref = theme; applyTheme(); }
  settings = { ...DEFAULTS, ...saved };
  $('label').value = settings.label;
  $('interval').value = settings.intervalMin;
  $('router-url').value = settings.routerUrl;
  $('router-on').checked = settings.routerOn !== false;
  showDetected();
  $('webhook').value = settings.webhookUrl;
  $('token').value = settings.token;
}

async function showDetected() {
  const { routerCache } = await chrome.storage.local.get('routerCache');
  $('router-found').textContent = routerCache?.url
    ? `Auto-detected: ${new URL(routerCache.url).hostname} (leave empty to keep auto-detecting)`
    : 'Leave empty to auto-detect';
}

function normalizeRouterUrl(u) {
  u = (u || '').trim();
  if (!u) return '';
  return /^https?:\/\//i.test(u) ? u : 'http://' + u;
}

// ---------- rendering ----------
const fmt = (v, d = 1) => (v == null ? '–' : Number(v).toFixed(d));

function cell(text, cls, colSpan) {
  const td = document.createElement('td');
  td.textContent = text;
  if (cls) td.className = cls;
  if (colSpan) td.colSpan = colSpan;
  return td;
}

function setRouter(badgeText, badgeClass, nodes) {
  const b = $('r-badge');
  b.textContent = badgeText;
  b.className = 'badge ' + (badgeClass || '');
  const d = $('r-detail');
  d.textContent = '';
  d.append(...nodes);
}

const bold = (t) => { const e = document.createElement('b'); e.textContent = t; return e; };
const txt = (t) => document.createTextNode(t);

function renderRouterIdle(last) {
  if (!last || last.routerStatus === 'off' || last.routerStatus == null) {
    setRouter(settings.routerOn === false ? 'Router off' : 'Router', '', [txt(settings.routerOn === false
      ? 'Turn on router checks in Settings'
      : 'Run a test: the router is auto-detected and pinged during the test')]);
    return;
  }
  switch (last.routerStatus) {
    case 'unreachable':
      setRouter('Unreachable', 'unreachable', [txt(`${last.routerAddr || 'Router'} did not answer; it will be re-detected next run`)]);
      break;
    case 'not found':
      setRouter('Not found', 'degraded', [txt('No router answered on the usual addresses; enter its address in Settings')]);
      break;
    default:
      setRouter(last.routerStatus === 'ok' ? 'Router OK under load' : 'Router slow under load', last.routerStatus, [
        txt(`${last.routerAddr ? last.routerAddr + ' · ' : ''}ping idle `), bold(`${fmt(last.routerIdle, 0)} ms`),
        txt(' · loaded '), bold(`${fmt(last.routerDown, 0)}/${fmt(last.routerUp, 0)} ms`),
        txt(` · loss ${fmt(last.routerLoss, 0)}%`),
      ]);
  }
}

const PHASE_LABEL = {
  prepare: 'Finding server & measuring latency',
  download: 'Measuring download',
  upload: 'Measuring upload',
};

function renderProgress(p, running) {
  const box = $('progress');
  box.hidden = !running;
  const cards = { down: document.querySelector('.stat.down'), up: document.querySelector('.stat.up'), ping: document.querySelector('.stat.ping') };
  Object.values(cards).forEach((c) => c.classList.remove('active'));
  if (!running) return;
  p = p || { phase: 'prepare', pct: 2 };

  $('p-fill').style.width = `${Math.max(2, Math.min(100, p.pct || 0))}%`;
  $('p-fill').parentElement.setAttribute('aria-valuenow', Math.round(p.pct || 0));
  const live = p.live != null && (p.phase === 'download' || p.phase === 'upload') ? ` · ${p.live.toFixed(1)} Mbps` : '';
  $('p-label').textContent = (PHASE_LABEL[p.phase] || 'Testing') + live;
  $('p-time').textContent = p.phaseTotalMs && p.phase !== 'prepare'
    ? `${(p.phaseMs / 1000).toFixed(1)} / ${(p.phaseTotalMs / 1000).toFixed(0)} s`
    : `${Math.round(p.pct || 0)}%`;

  const order = ['prepare', 'download', 'upload'];
  const idx = order.indexOf(p.phase);
  order.forEach((name, i) => {
    const el = $('st-' + name);
    el.className = i < idx ? 'done' : i === idx ? 'on' : '';
  });

  if (p.phase === 'prepare') cards.ping.classList.add('active');
  if (p.phase === 'download') cards.down.classList.add('active');
  if (p.phase === 'upload') cards.up.classList.add('active');
}

let lastLog = [];
let lastRunning = false;
let lastProgress = null;

function renderStats(running, p) {
  const last = [...lastLog].reverse().find((r) => r.status === 'ok');
  if (running) {
    $('s-down').textContent = fmt(p?.down);
    $('s-up').textContent = fmt(p?.up);
    $('s-ping').textContent = fmt(p?.ping, 0);
    $('server').textContent = p?.server ? `${p.server} · ${p.ip}` : 'Testing…';
  } else {
    $('s-down').textContent = last ? fmt(last.down) : '–';
    $('s-up').textContent = last ? fmt(last.up) : '–';
    $('s-ping').textContent = last ? fmt(last.ping, 0) : '–';
    $('server').textContent = last ? `${last.server} · ${last.ip}` : 'No tests yet';
  }
  if (running) {
    if (p?.routerEnabled) {
      const phase = p.routerPhase === 'idle' ? 'idle' : p.routerPhase === 'download' ? 'during download' : 'during upload';
      setRouter('Testing', '', p.router == null
        ? [txt('Router not answering…')]
        : [txt('Router ping '), bold(`${p.router.toFixed(0)} ms`), txt(` ${phase}`)]);
    } else {
      setRouter(p?.detecting ? 'Detecting' : 'Router off', '', [txt(p?.detecting ? 'Looking for your router…' : 'Router checks are off or no router was found')]);
    }
  } else {
    renderRouterIdle(lastLog[lastLog.length - 1]);
  }
}

async function render() {
  const { log = [], running, pending = [] } = await chrome.storage.local.get(['log', 'running', 'pending']);
  const { progress } = await chrome.storage.session.get('progress').catch(() => ({}));
  lastLog = log; lastRunning = !!running; lastProgress = progress || null;

  renderStats(lastRunning, lastProgress);
  renderProgress(lastProgress, lastRunning);

  const tbody = $('rows');
  tbody.textContent = '';
  log.slice(-10).reverse().forEach((r) => {
    const tr = document.createElement('tr');
    const t = new Date(r.time).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    tr.appendChild(cell(t));
    if (r.status === 'ok') {
      tr.appendChild(cell(fmt(r.down), 'num-down'));
      tr.appendChild(cell(fmt(r.up), 'num-up'));
      tr.appendChild(cell(`${fmt(r.ping, 0)} ms`, 'num-ping'));
      const routerCell = r.routerStatus === 'ok' || r.routerStatus === 'degraded'
        ? `${fmt(r.routerIdle, 0)} → ${fmt(Math.max(r.routerDown ?? 0, r.routerUp ?? 0), 0)} ms`
        : r.routerStatus === 'unreachable' ? 'no reply' : '–';
      tr.appendChild(cell(routerCell, r.routerStatus === 'degraded' ? 'num-ping' : r.routerStatus === 'unreachable' ? 'err' : ''));
    } else {
      tr.appendChild(cell(r.status, 'err', 4));
    }
    tbody.appendChild(tr);
  });
  $('empty').hidden = log.length > 0;
  $('count').textContent = log.length ? `· ${log.length} stored` : '';

  const run = $('run');
  run.disabled = lastRunning;
  run.textContent = lastRunning ? 'Testing…' : 'Run test now';
  const st = $('status');
  st.textContent = '';
  if (!lastRunning && pending.length) {
    st.textContent = `${pending.length} result${pending.length > 1 ? 's' : ''} waiting to upload to the sheet`;
  }
}

function toCsv(log) {
  const header = ['Time', 'Name', 'IP', 'Server', 'Down (Mbps)', 'Up (Mbps)', 'Ping (ms)', 'Status',
    'Router idle (ms)', 'Router loaded down (ms)', 'Router loaded up (ms)', 'Router max (ms)', 'Router loss (%)', 'Router status', 'Router address'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = log.map((r) => [r.time, r.label, r.ip, r.server, r.down, r.up, r.ping, r.status,
    r.routerIdle, r.routerDown, r.routerUp, r.routerMax, r.routerLoss, r.routerStatus, r.routerAddr].map(esc).join(','));
  return [header.map(esc).join(','), ...lines].join('\n');
}

function flash(msg) {
  $('status').textContent = msg;
  setTimeout(render, 2500);
}

// ---------- actions ----------
$('save').onclick = async () => {
  const routerUrl = normalizeRouterUrl($('router-url').value);
  const routerOn = $('router-on').checked;
  settings = {
    label: $('label').value.trim(),
    intervalMin: Math.max(1, Number($('interval').value) || 30),
    webhookUrl: $('webhook').value.trim(),
    token: $('token').value.trim(),
    routerOn,
    routerUrl,
  };
  await chrome.storage.local.set({ settings });
  flash('Settings saved.');
};

$('detect').onclick = async () => {
  const b = $('detect');
  b.disabled = true; b.textContent = 'Detecting…';
  const res = await chrome.runtime.sendMessage({ type: 'detectRouter' });
  b.disabled = false; b.textContent = 'Detect';
  $('router-found').textContent = res?.url
    ? `Found: ${new URL(res.url).hostname}`
    : 'No router found on the usual addresses; type its address instead';
};

$('run').onclick = () => {
  $('run').disabled = true;
  chrome.runtime.sendMessage({ type: 'runNow' });
};

$('csv').onclick = async () => {
  const { log = [] } = await chrome.storage.local.get('log');
  const blob = new Blob([toCsv(log)], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `speedlog-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
};

$('clear').onclick = async () => {
  if (confirm('Delete all locally stored results?')) {
    await chrome.storage.local.set({ log: [], pending: [] });
  }
};

chrome.storage.onChanged.addListener((_c, area) => {
  if (area === 'local' || area === 'session') render();
});
loadSettings().then(render);
