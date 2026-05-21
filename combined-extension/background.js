let RUNNING = false;
let ABORT = false;

const log  = (text) => chrome.runtime.sendMessage({ type: 'LOG',  text }).catch(()=>{});
const tick = ()     => chrome.runtime.sendMessage({ type: 'TICK' }).catch(()=>{});
const done = ()     => chrome.runtime.sendMessage({ type: 'DONE' }).catch(()=>{});

const NAV_TIMEOUT = 20000;
const SCRAPE_TIMEOUT = 15000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openTab(url) {
  const tab = await chrome.tabs.create({ url, active: false });
  await new Promise((resolve) => {
    const start = Date.now();
    const listener = (tabId, info) => {
      if (tabId === tab.id && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener); resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    const poll = setInterval(() => {
      if (Date.now() - start > NAV_TIMEOUT) {
        clearInterval(poll); chrome.tabs.onUpdated.removeListener(listener); resolve();
      }
    }, 500);
  });
  return tab;
}

function askTab(tabId, message, timeoutMs = SCRAPE_TIMEOUT) {
  return new Promise(async (resolve) => {
    const t = setTimeout(() => resolve(null), timeoutMs);
    try {
      const res = await chrome.tabs.sendMessage(tabId, message);
      clearTimeout(t); resolve(res);
    } catch { clearTimeout(t); resolve(null); }
  });
}

async function closeTab(id) { try { await chrome.tabs.remove(id); } catch {} }

async function processRow(headers, row, idx) {
  const I = (name) => headers.indexOf(name);
  const iTitle = I('Title'), iMaps = I('Google Maps Link');
  const iWeb = I('Website'), iPhone = I('Phone');
  const iIg  = I('Instagram'), iFb = I('Facebook'), iWa = I('WhatsApp'), iImg = I('Image');

  const title = row[iTitle] || '(no title)';
  const mapsUrl = row[iMaps];
  if (!mapsUrl) { log(`[${idx+1}] ${title}: no Maps link, skipped`); return; }

  log(`[${idx+1}] ${title}`);
  const mapsTab = await openTab(mapsUrl);
  await sleep(1500);
  const m = await askTab(mapsTab.id, { type: 'SCRAPE_MAPS' }) || {};
  await closeTab(mapsTab.id);

  const website = (m.website || '').trim();
  const phone   = (m.phone   || '').trim();
  if (iWeb   >= 0 && website && !row[iWeb])   row[iWeb]   = website;
  if (iPhone >= 0 && phone   && !row[iPhone]) row[iPhone] = phone;
  if (iImg   >= 0 && (m.image || '') && !row[iImg]) row[iImg] = m.image;
  if (iWa    >= 0 && phone   && !row[iWa]) {
    const d = phone.replace(/\D/g, '');
    if (d.length >= 7) row[iWa] = 'https://wa.me/' + d;
  }
  log(`   maps → website=${website || '-'}  phone=${phone || '-'}`);

  const targetSite = (row[iWeb] || '').trim();
  const real = targetSite && !/google\.com\/aclk|googleadservices/.test(targetSite);
  if (real) {
    let siteTab;
    try {
      siteTab = await openTab(targetSite);
      await sleep(1500);
      const site = await askTab(siteTab.id, { type: 'SCRAPE_SITE' }) || {};
      if (iIg >= 0 && site.instagram && !row[iIg]) row[iIg] = site.instagram;
      if (iFb >= 0 && site.facebook  && !row[iFb]) row[iFb] = site.facebook;
      if (iWa  >= 0 && site.whatsapp && (!row[iWa] || /^https:\/\/wa\.me\/$/.test(row[iWa]))) row[iWa]  = site.whatsapp;
      if (iImg >= 0 && site.image    && !row[iImg]) row[iImg] = site.image;
      log(`   site → ig=${site.instagram||'-'}  fb=${site.facebook||'-'}  wa=${site.whatsapp||'-'}  img=${site.image||'-'}`);
    } catch (e) { log(`   site error: ${e.message}`); }
    finally { if (siteTab) await closeTab(siteTab.id); }
  }
}

async function run() {
  if (RUNNING) return;
  RUNNING = true; ABORT = false;
  const { headers, rows, progress = 0 } = await chrome.storage.local.get(['headers','rows','progress']);
  if (!rows || !headers) { log('No rows in storage.'); RUNNING = false; done(); return; }
  log(`Enriching from row ${progress+1}/${rows.length}`);
  for (let i = progress; i < rows.length; i++) {
    if (ABORT) { log('Stopped.'); break; }
    try { await processRow(headers, rows[i], i); }
    catch (e) { log(`[${i+1}] error: ${e.message}`); }
    await chrome.storage.local.set({ rows, progress: i+1, status: `Enriched ${i+1}/${rows.length}` });
    tick();
    await sleep(800);
  }
  RUNNING = false;
  log('Enrichment done.');
  done();
  // Open results in a full tab so the user can review and type a filename
  // without the Chrome action popup closing on click-away.
  try { await chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?view=tab'), active: true }); } catch {}
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'START') run();
  if (msg.type === 'STOP')  ABORT = true;
});
