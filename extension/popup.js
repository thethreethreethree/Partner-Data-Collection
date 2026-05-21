const $ = (id) => document.getElementById(id);
const logEl = $('log');
const log = (m) => { logEl.textContent += m + '\n'; logEl.scrollTop = logEl.scrollHeight; };

// --- Minimal CSV parse/serialize (RFC4180-ish, handles quoted fields with embedded quotes/commas/newlines) ---
function parseCSV(text) {
  const rows = []; let cur = []; let val = ''; let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i+1] === '"') { val += '"'; i++; } else inQ = false; }
      else val += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { cur.push(val); val = ''; }
      else if (c === '\n') { cur.push(val); rows.push(cur); cur = []; val = ''; }
      else if (c === '\r') { /* skip */ }
      else val += c;
    }
  }
  if (val.length || cur.length) { cur.push(val); rows.push(cur); }
  return rows;
}
function toCSV(rows) {
  return rows.map(r => r.map(v => {
    v = v == null ? '' : String(v);
    return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  }).join(',')).join('\r\n');
}

async function loadState() {
  return (await chrome.storage.local.get(['headers','rows','status','progress'])) || {};
}
async function saveState(s) { await chrome.storage.local.set(s); }

$('csvFile').addEventListener('change', async (e) => {
  const file = e.target.files[0]; if (!file) return;
  const text = await file.text();
  const rows = parseCSV(text).filter(r => r.length > 1 || (r[0] && r[0].length));
  const headers = rows.shift();
  for (const col of ['Website','Instagram','WhatsApp','Phone']) {
    if (!headers.includes(col)) headers.push(col);
  }
  // Normalize each row to header length
  const norm = rows.map(r => { const o = Array(headers.length).fill(''); for (let i=0;i<r.length;i++) o[i]=r[i]; return o; });
  await saveState({ headers, rows: norm, progress: 0 });
  log(`Loaded ${norm.length} rows.`);
  refresh();
});

$('start').onclick = async () => {
  const s = await loadState();
  if (!s.rows) { log('Load a CSV first.'); return; }
  await chrome.runtime.sendMessage({ type: 'START' });
};
$('stop').onclick  = () => chrome.runtime.sendMessage({ type: 'STOP' });
$('clear').onclick = async () => { await chrome.storage.local.clear(); logEl.textContent=''; refresh(); };

$('export').onclick = async () => {
  const { headers, rows } = await loadState();
  if (!rows) return;
  const csv = toCSV([headers, ...rows]);
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  chrome.downloads ? chrome.downloads.download({ url, filename: 'hotels_enriched.csv' })
                   : Object.assign(document.createElement('a'), { href: url, download: 'hotels_enriched.csv' }).click();
};

async function refresh() {
  const { rows, progress, status } = await loadState();
  $('prog').max = rows ? rows.length : 1;
  $('prog').value = progress || 0;
  $('status').textContent = status || (rows ? `${rows.length} rows loaded` : 'No CSV loaded');
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'LOG') log(msg.text);
  if (msg.type === 'TICK') refresh();
});
refresh();
