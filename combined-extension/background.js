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

function validIg(url) {
  const m = (url || '').match(/instagram\.com\/([^\/?#]+)/i);
  if (!m) return false;
  const bad = ['p','explore','reel','reels','accounts','about','directory','tv','stories','sharer'];
  return !bad.includes(m[1].toLowerCase());
}

// Reject IG handles that don't share a meaningful token with the business name.
// Used only for low-trust sources (DDG search results).
function igHandleMatchesName(igUrl, name) {
  const m = (igUrl || '').match(/instagram\.com\/([^\/?#]+)/i);
  if (!m) return false;
  const handle = m[1].toLowerCase().replace(/[^a-z0-9]/g, '');
  const stop = new Set(['the','and','of','at','in','el','la','le','de','los','las',
    'hotel','hostel','inn','resort','beach','lodge','villas','villa','suites','suite',
    'tourist','house','garden','boutique','bay','place','pension','apartelle','room',
    'rooms','cottages','cottage','cabanas','cabana','travelodge','lodging','reef',
    'island','frontier']);
  const all = (name || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
  const meaningful = all.filter((t) => !stop.has(t));
  const tokens = meaningful.length ? meaningful : all;
  return tokens.some((t) => handle.includes(t));
}

// Tier 3: scrape DuckDuckGo for the business's Instagram/Facebook.
async function searchSocials(query) {
  const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query);
  let tab;
  try {
    tab = await openTab(url);
    await sleep(1200);
    const res = await askTab(tab.id, { type: 'SCRAPE_SEARCH' }) || {};
    return res;
  } catch { return {}; }
  finally { if (tab) await closeTab(tab.id); }
}

async function processRow(headers, row, idx) {
  const I = (name) => headers.indexOf(name);
  const iTitle = I('Title'), iMaps = I('Google Maps Link');
  const iWeb = I('Website'), iPhone = I('Phone');
  const iIg  = I('Instagram'), iFb = I('Facebook'), iWa = I('WhatsApp'), iImg = I('Image'), iAm = I('Amenities');
  const iAddr = I('Address'), iInd = I('Industry');

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
  // Place-page data is authoritative — override the scraper's text-regex guesses.
  if (iWeb   >= 0 && website) row[iWeb]   = website;
  if (iPhone >= 0 && phone) {
    row[iPhone] = phone;
    if (iWa >= 0) {
      const d = phone.replace(/\D/g, '');
      // Refresh WhatsApp if missing or it was the placeholder derived from
      // a previous (possibly wrong) phone — but not if user-set wa.me link.
      const cur = row[iWa] || '';
      if (!cur || /^https:\/\/wa\.me\/\d*$/.test(cur)) {
        row[iWa] = d.length >= 7 ? 'https://wa.me/' + d : '';
      }
    }
  }
  if (iAddr >= 0 && (m.address || '')) row[iAddr] = m.address;
  if (iInd  >= 0 && (m.category || '')) row[iInd] = m.category;
  // Image: the place-page photo is hi-res — prefer it over any low-res
  // search-card thumbnail captured during scraping. Only keep an existing
  // value if it's already a non-Google (e.g. website) image.
  if (iImg >= 0 && (m.image || '')) {
    const cur = row[iImg] || '';
    const curIsGoogleThumb = /googleusercontent\.com|ggpht\.com/.test(cur);
    if (!cur || curIsGoogleThumb) row[iImg] = m.image;
  }
  if (iAm    >= 0 && (m.amenities || '')) row[iAm] = m.amenities;
  // Tier 1: the "website" may itself be a social/Linktree URL.
  if (iIg >= 0 && website && /instagram\.com\//i.test(website) && !row[iIg]) {
    const ig = website.match(/https?:\/\/(www\.)?instagram\.com\/[^\/?#]+/i);
    if (ig && validIg(ig[0])) row[iIg] = ig[0];
  }
  if (iFb >= 0 && website && /facebook\.com\//i.test(website) && !row[iFb]) {
    const fb = website.match(/https?:\/\/(www\.|m\.)?facebook\.com\/[^\/?#]+/i);
    if (fb) row[iFb] = fb[0];
  }
  log(`   maps → website=${website || '-'}  phone=${phone || '-'}`);

  const targetSite = (row[iWeb] || '').trim();
  // Visit real sites AND link-aggregators (Linktree etc.), but not Google ad redirects
  // or links that are themselves the IG/FB profile (nothing more to scrape there).
  const isProfileOnly = /^https?:\/\/(www\.)?(instagram|facebook)\.com\//i.test(targetSite);
  const real = targetSite && !/google\.com\/aclk|googleadservices/.test(targetSite) && !isProfileOnly;
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

  // Tier 3: still missing Instagram? Search DuckDuckGo by name (+ location hint).
  const needIg = iIg >= 0 && !row[iIg];
  const needFb = iFb >= 0 && !row[iFb];
  if (needIg || needFb) {
    const addr = (headers.indexOf('Address') >= 0 ? row[headers.indexOf('Address')] : '') || '';
    // Add the address as a location hint only if the name doesn't already contain it.
    const loc = addr && !title.toLowerCase().includes(addr.toLowerCase().slice(0, 8)) ? ' ' + addr : '';
    const q = `${title}${loc} instagram`;
    const s = await searchSocials(q);
    let igAccepted = '';
    if (needIg && s.instagram) {
      if (igHandleMatchesName(s.instagram, title)) {
        row[iIg] = s.instagram; igAccepted = s.instagram;
      } else {
        log(`   ddg  ✗ ig rejected (no name match): ${s.instagram}`);
      }
    }
    if (needFb && s.facebook) row[iFb] = s.facebook;
    log(`   ddg  → ig=${igAccepted || '-'}  fb=${s.facebook || '-'}`);
    await sleep(1500); // extra throttle for search engine
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
  // Final strict category filter — using authoritative Industry from the place page.
  try {
    const { searchCats } = await chrome.storage.local.get('searchCats');
    if (searchCats && searchCats.length) {
      const iInd = headers.indexOf('Industry');
      const iTitle = headers.indexOf('Title');
      const before = rows.length;
      const kept = rows.filter((r) => {
        const blob = ((r[iInd] || '') + ' ' + (r[iTitle] || '')).toLowerCase();
        return searchCats.some((c) => blob.includes(c));
      });
      const removed = before - kept.length;
      if (removed > 0) {
        await chrome.storage.local.set({ rows: kept, progress: kept.length,
          status: `${kept.length} rows · ${removed} removed by category filter` });
        log(`Category filter (${searchCats.join(', ')}) removed ${removed} mismatched rows.`);
        tick();
      }
    }
  } catch (e) { log(`category filter error: ${e.message}`); }

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
