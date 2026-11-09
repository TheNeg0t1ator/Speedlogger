const $ = (id) => document.getElementById(id);
const DEFAULTS = { intervalMin: 30, label: '', webhookUrl: '', token: '' };

async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  const s = { ...DEFAULTS, ...settings };
  $('label').value = s.label;
  $('interval').value = s.intervalMin;
  $('webhook').value = s.webhookUrl;
  $('token').value = s.token;
}

async function render() {
  const { log = [], running, pending = [] } = await chrome.storage.local.get(['log', 'running', 'pending']);
  const tbody = $('rows');
  tbody.textContent = '';
  log.slice(-10).reverse().forEach((r) => {
    const tr = document.createElement('tr');
    const t = new Date(r.time).toLocaleString();
    const cells = r.status === 'ok'
      ? [t, r.down + ' Mbps', r.up + ' Mbps', r.ping + ' ms', r.server]
      : [t, '-', '-', '-', r.status];
    cells.forEach((c) => { const td = document.createElement('td'); td.textContent = c; tr.appendChild(td); });
    tbody.appendChild(tr);
  });
  const parts = [`${log.length} results stored`];
  if (pending.length) parts.push(`${pending.length} waiting to upload`);
  if (running) parts.push('test running...');
  $('status').textContent = parts.join(' · ');
}

function toCsv(log) {
  const header = ['Time', 'Name', 'IP', 'Server', 'Down (Mbps)', 'Up (Mbps)', 'Ping (ms)', 'Status'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = log.map((r) => [r.time, r.label, r.ip, r.server, r.down, r.up, r.ping, r.status].map(esc).join(','));
  return [header.map(esc).join(','), ...lines].join('\n');
}

$('save').onclick = async () => {
  await chrome.storage.local.set({
    settings: {
      label: $('label').value.trim(),
      intervalMin: Math.max(1, Number($('interval').value) || 30),
      webhookUrl: $('webhook').value.trim(),
      token: $('token').value.trim(),
    },
  });
  $('status').textContent = 'Saved.';
};

$('run').onclick = () => {
  $('status').textContent = 'test running... (takes ~40 seconds)';
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
