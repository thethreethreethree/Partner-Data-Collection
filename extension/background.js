// Orchestrates scraping: for each row, open the Google Maps Link in a tab,
// ask the Maps content script for {website, phone}, then if a website exists,
// open it and ask the site content script for {instagram, facebook, whatsapp}.

let RUNNING = false;
let ABORT = false;

const log = (text) => chrome.runtime.sendMessage({ type: 'LOG', text }).catch(()=>{});
const tick = () => chrome.runtime.sendMessage({ type: 'TICK' }).catch(()=>{});

const NAV_TIMEOUT = 20000;
const SCRAPE_TIMEOUT = 15000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function openTab(url) {
  const tab = await chrome.tabs.create({ url, active: false });
  // Wait for tab to finish loading
  await new Promise((resolve) => {
    const start = Date.now();
    const listener = (tabId, info) => {
      if (tabId === tab.id && info.status === 'complete') { chrome.tabs.onUpdated.removeListener(listener); resolve(); }
    };
    chrome.tabs.onUpdated.addListener(listener);
    const poll = setInterval(() => {
      if (Date.now() - start > NAV_TIMEOUT) { clearInterval(poll); chrome.tabs.onUpdated.removeListener(listener); resolve(); }
    }, 500);
  });
  return tab;
}

async function askTab(tabId, message, timeoutMs = SCRAPE_TIMEOUT) {
  return new Promise(async (resolve) => {
    const t = setTimeout(() => resolve(null), timeoutMs);
    try {
      const res = await chrome.tabs.sendMessage(tabId, message);
      clearTimeout(t); resolve(res);
    } catch (e) { clearTimeout(t); resolve(null); }
  });
}

async function closeTab(id) { try { await chrome.tabs.remove(id); } catch {} }

async function processRow(headers, row, idx) {
  const titleI = headers.indexOf('Title');
  const mapsI  = headers.indexOf('Google Maps Link');
  const webI   = headers.indexOf('Website');
  const phoneI = headers.indexOf('Phone');
  const igI    = headers.indexOf('Instagram');
  const waI    = headers.indexOf('WhatsApp');
  // No dedicated Facebook column in source CSV — store inside "Industry" only if user adds it; otherwise skipped.
  const fbI    = headers.indexOf('Facebook');

  const title = row[titleI] || '(no title)';
  const mapsUrl = row[mapsI];
  if (!mapsUrl) { log(`[${idx+1}] ${title}: no Maps link, skipped`); return; }

  log(`[${idx+1}] ${title}`);
  const mapsTab = await openTab(mapsUrl);
  await sleep(1500); // give Maps sidebar time to populate
  const mapsData = await askTab(mapsTab.id, { type: 'SCRAPE_MAPS' }) || {};
  await closeTab(mapsTab.id);

  let website = (mapsData.website || '').trim();
  let phone   = (mapsData.phone   || '').trim();
  if (website && !row[webI])   row[webI]   = website;
  if (phone   && !row[phoneI]) row[phoneI] = phone;
  log(`   maps → website=${website || '-'}  phone=${phone || '-'}`);

  // Only scrape the site if it's a real external site (not a Google ad redirect).
  const realSite = website && !/google\.com\/aclk|googleadservices/.test(website);
  if (realSite) {
    let siteTab;
    try {
      siteTab = await openTab(website);
      await sleep(1500);
      const site = await askTab(siteTab.id, { type: 'SCRAPE_SITE' }) || {};
      if (site.instagram && !row[igI]) row[igI] = site.instagram;
      if (site.whatsapp  && !row[waI]) row[waI] = site.whatsapp;
      if (fbI >= 0 && site.facebook && !row[fbI]) row[fbI] = site.facebook;
      log(`   site → ig=${site.instagram||'-'}  fb=${site.facebook||'-'}  wa=${site.whatsapp||'-'}`);
    } catch (e) { log(`   site error: ${e.message}`); }
    finally { if (siteTab) await closeTab(siteTab.id); }
  }
}

async function run() {
  if (RUNNING) return;
  RUNNING = true; ABORT = false;
  const { headers, rows, progress=0 } = await chrome.storage.local.get(['headers','rows','progress']);
  if (!rows) { log('No rows.'); RUNNING = false; return; }
  log(`Starting at row ${progress+1}/${rows.length}`);
  for (let i = progress; i < rows.length; i++) {
    if (ABORT) { log('Stopped.'); break; }
    try { await processRow(headers, rows[i], i); }
    catch (e) { log(`[${i+1}] error: ${e.message}`); }
    await chrome.storage.local.set({ rows, progress: i+1, status: `Processed ${i+1}/${rows.length}` });
    tick();
    await sleep(800); // polite throttle
  }
  RUNNING = false;
  log('Done.');
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'START') run();
  if (msg.type === 'STOP')  { ABORT = true; }
});
