// ISP Speed Logger - Google Apps Script web app
// Paste into Extensions -> Apps Script, then Deploy -> Manage deployments -> New version.
const TOKEN = 'seppe';                      // must match "Shared secret token" in the extension
const SHEET_NAME = 'Speed Log';
const SHEET_ID = '1Gwpp_kJj3QocAj1gHwfA7NgXte6CRPwE97uG8Jy90D4'; // fallback if script is not bound to the sheet
const HEADERS = ['Time', 'Name', 'IP', 'Server', 'Down (Mbps)', 'Up (Mbps)', 'Ping (ms)', 'Status',
  'Router idle (ms)', 'Router loaded down (ms)', 'Router loaded up (ms)', 'Router max (ms)', 'Router loss (%)', 'Router status'];
 
// Pivot sheets used by the charts: [sheet name, column index in "Speed Log" (0-based), chart title]
const METRICS = [
  { sheet: 'Data Download', col: 4, title: 'Download (Mbps) per user' },
  { sheet: 'Data Upload',   col: 5, title: 'Upload (Mbps) per user' },
  { sheet: 'Data Ping',     col: 6, title: 'Ping (ms) per user' },
];
 
function getSpreadsheet() {
  return SpreadsheetApp.getActiveSpreadsheet() || SpreadsheetApp.openById(SHEET_ID);
}
 
function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    const d = JSON.parse(e.postData.contents);
    if (d.token !== TOKEN) {
      console.error('bad token, received: ' + JSON.stringify(d.token));
      return out({ ok: false, error: 'bad token' });
    }
    lock.waitLock(20000);
    const ss = getSpreadsheet();
    const sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sheet.setFrozenRows(1);
    sheet.appendRow([new Date(d.time), d.label, d.ip, d.server, d.down, d.up, d.ping, d.status,
      d.routerIdle, d.routerDown, d.routerUp, d.routerMax, d.routerLoss, d.routerStatus]);
    sheet.getRange('A:A').setNumberFormat('yyyy-mm-dd hh:mm:ss');
    try { rebuildPivots(); } catch (err) { console.error('pivot rebuild failed: ' + err); } // never block logging
    return out({ ok: true });
  } catch (err) {
    console.error(String(err));
    return out({ ok: false, error: String(err) });
  } finally {
    try { lock.releaseLock(); } catch (_) { /* not held */ }
  }
}
 
// Open the /exec URL in a browser to check the deployment is public and alive.
function doGet() {
  return out({ ok: true, info: 'ISP Speed Logger endpoint is running (POST only)' });
}
 
function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
 
// ---------- Charts ----------
// Run setupCharts ONCE from the editor (select it in the dropdown, press Run).
// After that every new test row refreshes the pivot sheets automatically and the charts follow.
 
const toNum = (v) => (typeof v === 'number' ? v : Number(String(v).replace(',', '.')));
const toDate = (v) => (v instanceof Date ? v : new Date(v));
 
// Writes, per metric, a sheet with the time down the side and one column per user.
function rebuildPivots() {
  const ss = getSpreadsheet();
  const src = ss.getSheetByName(SHEET_NAME);
  if (!src || src.getLastRow() < 2) return;
  const rows = src.getRange(2, 1, src.getLastRow() - 1, HEADERS.length).getValues()
    .filter((r) => r[0] && String(r[1]).trim() && r[7] === 'ok')
    .map((r) => ({ t: toDate(r[0]), user: String(r[1]).trim(), r }))
    .filter((x) => !isNaN(x.t.getTime()));
  const users = [...new Set(rows.map((x) => x.user))].sort();
 
  METRICS.forEach((m) => {
    const d = ss.getSheetByName(m.sheet) || ss.insertSheet(m.sheet);
    d.clearContents();
    const byTime = new Map();
    rows.forEach((x) => {
      const key = x.t.getTime();
      if (!byTime.has(key)) byTime.set(key, { t: x.t, vals: {} });
      const v = toNum(x.r[m.col]);
      if (!isNaN(v)) byTime.get(key).vals[x.user] = v;
    });
    const body = [...byTime.values()].sort((a, b) => a.t - b.t)
      .map((e) => [e.t, ...users.map((u) => (u in e.vals ? e.vals[u] : ''))]);
    if (!users.length || !body.length) return;
    d.getRange(1, 1, 1, users.length + 1).setValues([['Time', ...users]]);
    d.getRange(2, 1, body.length, users.length + 1).setValues(body);
    d.getRange('A:A').setNumberFormat('yyyy-mm-dd hh:mm');
  });
}
 
function setupCharts() {
  const ss = getSpreadsheet();
  rebuildPivots();
  const charts = ss.getSheetByName('Charts') || ss.insertSheet('Charts');
  charts.getCharts().forEach((c) => charts.removeChart(c));
  METRICS.forEach((m, i) => {
    const d = ss.getSheetByName(m.sheet) || ss.insertSheet(m.sheet);
    const chart = charts.newChart()
      .setChartType(Charts.ChartType.LINE)
      .addRange(d.getRange('A1:K2000'))   // time + up to 10 users; empty columns are ignored
      .setNumHeaders(1)
      .setOption('title', m.title)
      .setOption('interpolateNulls', true) // connect each user's points across other users' timestamps
      .setOption('legend', { position: 'bottom' })
      .setOption('width', 900)
      .setOption('height', 360)
      .setPosition(1 + i * 19, 1, 0, 0)
      .build();
    charts.insertChart(chart);
  });
}