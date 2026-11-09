const $ = (id) => document.getElementById(id);
const DEFAULTS = { intervalMin: 30, label: '', webhookUrl: '', token: '' };

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
async function loadSettings() {
  const { settings, theme } = await chrome.storage.local.get(['settings', 'theme']);
  if (theme) { themePref = theme; applyTheme(); }
  const s = { ...DEFAULTS, ...settings };
  $('label').value = s.label;
  $('interval').value = s.intervalMin;
  $('webhook').value = s.webhookUrl;
  $('token').value = s.token;
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

async function render() {
  const { log = [], running, pending = [] } = await chrome.storage.local.get(['log', 'running', 'pending']);

  const last = [...log].reverse().find((r) => r.status === 'ok');
  $('s-down').textContent = last ? fmt(last.down) : '–';
  $('s-up').textContent = last ? fmt(last.up) : '–';
  $('s-ping').textContent = last ? fmt(last.ping, 0) : '–';
  $('server').textContent = last ? `${last.server} · ${last.ip}` : 'No tests yet';

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
    } else {
      tr.appendChild(cell(r.status, 'err', 3));
    }
    tbody.appendChild(tr);
  });
  $('empty').hidden = log.length > 0;
  $('count').textContent = log.length ? `· ${log.length} stored` : '';

  const run = $('run');
  run.disabled = !!running;
  run.textContent = running ? 'Testing…' : 'Run test now';
  const st = $('status');
  st.textContent = '';
  if (running) {
    const dot = document.createElement('span');
    dot.className = 'pulse';
    st.append(dot, 'Test running, takes about 40 seconds');
  } else if (pending.length) {
    st.textContent = `${pending.length} result${pending.length > 1 ? 's' : ''} waiting to upload to the sheet`;
  }
}

function toCsv(log) {
  const header = ['Time', 'Name', 'IP', 'Server', 'Down (Mbps)', 'Up (Mbps)', 'Ping (ms)', 'Status'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = log.map((r) => [r.time, r.label, r.ip, r.server, r.down, r.up, r.ping, r.status].map(esc).join(','));
  return [header.map(esc).join(','), ...lines].join('\n');
}

function flash(msg) {
  $('status').textContent = msg;
  setTimeout(render, 2000);
}

// ---------- actions ----------
$('save').onclick = async () => {
  await chrome.storage.local.set({
    settings: {
      label: $('label').value.trim(),
      intervalMin: Math.max(1, Number($('interval').value) || 30),
      webhookUrl: $('webhook').value.trim(),
      token: $('token').value.trim(),
    },
  });
  flash('Settings saved.');
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

chrome.storage.onChanged.addListener((_c, area) => { if (area === 'local') render(); });
loadSettings();
render();
