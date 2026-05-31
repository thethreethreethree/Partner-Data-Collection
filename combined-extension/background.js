let RUNNING = false;
let ABORT = false;
let PAUSED = false;

// --- Auto-save: snapshot the in-progress dataset every 10 minutes while a
//     batch is running. Goes to your Downloads folder + a backup copy in
//     chrome.storage.local. Service-worker-driven so it works whether the
//     popup is open or closed. ---
const AUTOSAVE_ALARM = 'partner-collection-autosave';

function parseCSV(text) {
  const rows = []; let row = [], cur = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (inQ) {
      if (c === '"' && n === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
      else if (c === '\r') {}
      else cur += c;
    }
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

function csvFromRows(headers, rows) {
  return [headers, ...rows].map((r) => r.map((v) => {
    v = v == null ? '' : String(v);
    return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  }).join(',')).join('\r\n');
}
function dataUrlFor(csv) {
  // UTF-8-safe base64.
  const utf8 = unescape(encodeURIComponent(csv));
  return 'data:text/csv;charset=utf-8;base64,' + btoa(utf8);
}
async function autoSaveNow(reason) {
  try {
    const { headers, rows, batchName } = await chrome.storage.local.get(['headers','rows','batchName']);
    if (!rows || !headers || rows.length === 0) return;
    const csv = csvFromRows(headers, rows);
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const base = (batchName || 'batch').replace(/[^a-z0-9_-]+/gi, '_').toLowerCase();
    const filename = `${base}_autosave_${ts}.csv`;
    // Keep a copy in storage so we can recover even if the file is lost.
    await chrome.storage.local.set({ lastAutoSave: { ts, rows: rows.length, filename } });
    chrome.downloads.download({ url: dataUrlFor(csv), filename, saveAs: false, conflictAction: 'uniquify' }).catch(()=>{});
    log(`💾 Auto-saved ${rows.length} rows → ${filename}${reason ? ' (' + reason + ')' : ''}`);
  } catch (e) {
    log(`auto-save error: ${e.message}`);
  }
}
function startAutoSave() {
  chrome.alarms.create(AUTOSAVE_ALARM, { periodInMinutes: 10, delayInMinutes: 10 });
}
function stopAutoSave() {
  chrome.alarms.clear(AUTOSAVE_ALARM).catch(()=>{});
}
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTOSAVE_ALARM) autoSaveNow('10-min auto-save');
});

// ---------------------------------------------------------------------------
// Local enrichment — same NDJSON streaming the popup used to do, but runs in
// the service worker so closing/minimizing the popup doesn't kill it. Live
// state is persisted to chrome.storage.local.localEnrichState; the popup
// reads it on open and subscribes to chrome.storage.onChanged for updates.
// ---------------------------------------------------------------------------
let LOCAL_ENRICH_ACTIVE = false;

async function runLocalEnrich(csvText, streamUrl) {
  if (LOCAL_ENRICH_ACTIVE) { log('Local enrichment already running — ignored.'); return; }
  LOCAL_ENRICH_ACTIVE = true;
  const totalHint = Math.max(0, csvText.split('\n').filter((l) => l.trim().length).length - 1);

  let state = {
    phase: 'starting', sub: 'instagram',
    total: totalHint, completed: 0, filled: 0, missed: 0, postsCount: 0,
    currentName: '', paused: false, ts: Date.now(),
  };
  const saveState = () => {
    state.ts = Date.now();
    return chrome.storage.local.set({ localEnrichState: { ...state } });
  };
  await saveState();
  log(`Streaming ${totalHint} rows from ${streamUrl}…`);

  try {
    const res = await fetch(streamUrl, {
      method: 'POST',
      headers: { 'content-type': 'text/csv' },
      body: csvText,
    });
    if (!res.ok || !res.body) {
      const msg = await res.text().catch(() => res.statusText);
      log(`⚠️ Local enricher failed (${res.status}): ${msg}`);
      state.phase = 'error'; state.error = `${res.status}: ${msg}`;
      await saveState();
      return;
    }
    state.phase = 'running'; await saveState();

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let finalCsv = null;

    readLoop: while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const t = line.trim(); if (!t) continue;
        let ev; try { ev = JSON.parse(t); } catch { continue; }

        if (ev.type === 'start') {
          state.total = ev.total || state.total;
          state.sub = 'instagram';
        } else if (ev.type === 'ig-row') {
          state.completed++;
          if (ev.handle) { state.filled++; log(`✓ ${ev.name} → ${ev.handle}`); }
          else           { state.missed++; }
          state.currentName = ev.name;
        } else if (ev.type === 'phase' && ev.phase === 'igposts') {
          state.sub = 'igposts'; state.completed = 0;
          state.total = ev.total || 0;
          log(`— Phase: IG posts (${ev.total} accounts)`);
        } else if (ev.type === 'igposts-row') {
          state.completed++;
          if (ev.count > 0) state.postsCount += ev.count;
          state.currentName = ev.name;
        } else if (ev.type === 'done') {
          finalCsv = ev.csv;
          state.phase = 'done';
          state.summary = {
            filled: ev.filled, already: ev.already, total: ev.total,
            posts: ev.posts, loggedIn: !!ev.loggedIn,
          };
          break readLoop;
        } else if (ev.type === 'error') {
          state.phase = 'error'; state.error = ev.message;
          break readLoop;
        }
        await saveState();
      }
    }

    // On success: write the new CSV (with IG handles + IG_Img_1..6) back into
    // storage so the popup table reflects the enriched data.
    if (finalCsv) {
      const parsed = parseCSV(finalCsv).filter((r) => r.some((v) => (v || '').length));
      if (parsed.length) {
        const newHeaders = parsed.shift();
        const newRows = parsed.map((r) => {
          const o = new Array(newHeaders.length).fill('');
          for (let i = 0; i < r.length && i < newHeaders.length; i++) o[i] = r[i] ?? '';
          return o;
        });
        await chrome.storage.local.set({ headers: newHeaders, rows: newRows });
        log(`✓ Local enrichment complete — ${newRows.length} rows updated.`);
      }
    }
    await saveState();
  } catch (e) {
    log(`⚠️ Local enrichment error: ${e.message}`);
    state.phase = 'error'; state.error = e.message;
    await saveState();
  } finally {
    LOCAL_ENRICH_ACTIVE = false;
  }
}

async function awaitResume() {
  if (!PAUSED) return;
  log('⏸ Batch paused — waiting for resume…');
  const { batchState = {} } = await chrome.storage.local.get('batchState');
  await chrome.storage.local.set({ batchState: { ...batchState, paused: true, ts: Date.now() } });
  while (PAUSED && !ABORT) {
    await sleep(1000);
  }
  const cur = (await chrome.storage.local.get('batchState')).batchState || {};
  await chrome.storage.local.set({ batchState: { ...cur, paused: false, ts: Date.now() } });
  if (!ABORT) log('▶ Resuming batch.');
}

// Mirror of popup.js CATEGORY_TERMS — used for conflict-only filtering.
const CATEGORY_TERMS = [
  'hostel','hotel','resort','motel','inn','guesthouse','guest house',
  'bed and breakfast','b&b','apartment','apartelle','villa','cottage','lodge',
  'pension','homestay','campsite','glamping',
  'restaurant','cafe','coffee','bakery','bar','pub','brewery','diner',
  'nightlife','nightclub','night club','club','lounge','disco',
  'spa','gym','salon','barber','clinic','dentist','pharmacy',
  'museum','gallery','park','beach','dive shop','tour'
];
function conflictsWithCategory(industry, cats) {
  if (!cats.length || !industry) return false;
  const ind = industry.toLowerCase();
  if (cats.some((c) => ind.includes(c))) return false;        // matches → keep
  return CATEGORY_TERMS.some((c) => !cats.includes(c) && ind.includes(c)); // says another category → drop
}

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
    if (res && res.captcha) {
      try { await chrome.tabs.update(tab.id, { active: true }); } catch {}
      return res; // leave the tab open so the user can solve it
    }
    await closeTab(tab.id);
    return res;
  } catch (e) {
    if (tab) await closeTab(tab.id);
    return {};
  }
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
  if (m && m.captcha) {
    try { await chrome.tabs.update(mapsTab.id, { active: true }); } catch {}
    ABORT = true;
    log(`⚠️ Google Maps captcha detected. Solve it in the open tab, then click Enrich Data to resume.`);
    return;
  }
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
  // search-card thumbnail OR Google's default_user.png placeholder. Keep
  // an existing value only if it's a real non-Google (e.g. website) image.
  if (iImg >= 0 && (m.image || '')) {
    const cur = row[iImg] || '';
    const curIsGoogleThumb = /googleusercontent\.com|ggpht\.com/.test(cur);
    const curIsPlaceholder = /ssl\.gstatic\.com\/local\/servicebusiness|default_user\.png|maps\/api\/staticmap/i.test(cur);
    if (!cur || curIsGoogleThumb || curIsPlaceholder) row[iImg] = m.image;
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
    if (s && s.captcha) {
      ABORT = true;
      log(`⚠️ DuckDuckGo captcha detected. Solve it in the open tab, then click Enrich Data to resume.`);
      return;
    }
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
      // Conflict-only: drop a row ONLY if its authoritative Industry clearly
      // names a different category (e.g. "Restaurant" when we asked for "hotel").
      // A row whose Title contains the queried category always passes.
      const kept = rows.filter((r) => {
        const title = (r[iTitle] || '').toLowerCase();
        if (searchCats.some((c) => title.includes(c))) return true;
        return !conflictsWithCategory(r[iInd] || '', searchCats);
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

  // Completion report: per-field fill rate across the final rows.
  try {
    const { rows: finalRows = [], headers: finalHeaders = [] } =
      await chrome.storage.local.get(['rows', 'headers']);
    if (finalRows.length) {
      const pct = (col) => {
        const i = finalHeaders.indexOf(col);
        if (i < 0) return null;
        const n = finalRows.filter((r) => (r[i] || '').toString().trim()).length;
        return Math.round(100 * n / finalRows.length);
      };
      const cols = ['Image','Instagram','Facebook','Phone','Website','WhatsApp','Amenities','Address','Industry'];
      const parts = cols.map((c) => {
        const p = pct(c);
        return p == null ? null : `${c} ${p}%`;
      }).filter(Boolean);
      log(`Completion (${finalRows.length} rows): ${parts.join(' · ')}`);
    }
  } catch (e) { log(`report error: ${e.message}`); }

  RUNNING = false;
  log('Enrichment done.');
  done();
  // Open results in a full tab so the user can review and type a filename
  // without the Chrome action popup closing on click-away.
  try { await chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?view=tab'), active: true }); } catch {}
}

// ---------------------------------------------------------------------------
// Batch mode: take a location + list of categories, sweep all Maps searches,
// dedupe across them, tag each row with its Source Query, then enrich.
// ---------------------------------------------------------------------------

const BATCH_HEADERS = ['Title','Rating','Reviews','Phone','WhatsApp','Instagram','Facebook','Industry','Address','Website','Image','Amenities','Pitch','Latitude','Longitude','Google Maps Link','Source Query','City'];
const BATCH_KEYS    = ['title','rating','reviewCount','phone','whatsapp','instagram','facebook','industry','address','companyUrl','image','amenities','pitch','latitude','longitude','href','sourceQuery','city'];

// Persist + broadcast. Persisting means the popup can render the latest
// batch state even if it was closed during the run.
const batchEvent = async (payload) => {
  try {
    const prev = (await chrome.storage.local.get('batchState')).batchState || {};
    const merged = { ...prev, ...payload, ts: Date.now() };
    if (payload.phase === 'scraping') merged.currentQuery = payload.query;
    if (payload.phase === 'scraped') {
      merged.runningTotal = payload.runningTotal;
      merged.lastResult = { query: payload.query, scraped: payload.scraped, kept: payload.kept };
    }
    await chrome.storage.local.set({ batchState: merged });
  } catch {}
  chrome.runtime.sendMessage({ type: 'BATCH', ...payload }).catch(() => {});
};

async function scrapeQueryTab(query) {
  const url = 'https://www.google.com/maps/search/' + encodeURIComponent(query);
  const tab = await openTab(url);
  // Maps needs a beat to render the search panel before we scroll/extract.
  await sleep(3000);
  let cards = [];
  let captcha = false;
  try {
    // Quick captcha check before injecting the heavy scrape script.
    const [probe] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => /\/sorry\//i.test(location.pathname) ||
                  /unusual traffic|systems have detected unusual|verify (you are|that you're) not a robot/i.test(
                    (document.body && document.body.innerText) || ''),
    }).catch(() => [{ result: false }]);
    if (probe && probe.result) {
      captcha = true;
      try { await chrome.tabs.update(tab.id, { active: true }); } catch {}
    } else {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['scrape_in_page.js'],
      });
      cards = (results && results[0] && results[0].result) || [];
    }
  } catch (e) {
    log(`scrape failed for "${query}": ${e.message}`);
  }
  if (!captcha) await closeTab(tab.id);
  return { cards, captcha };
}

async function runBatch(cities, categories) {
  console.log('[batch] runBatch called', { cities, categories, RUNNING });
  if (RUNNING) { log('Batch ignored — another run is already in progress.'); return; }
  if (!Array.isArray(cities) || cities.length === 0 || !Array.isArray(categories) || categories.length === 0) {
    log(`Batch ignored — bad args (cities=${JSON.stringify(cities)}, categories=${JSON.stringify(categories)}).`);
    return;
  }
  RUNNING = true; ABORT = false; PAUSED = false;
  startAutoSave();
  const totalQueries = cities.length * categories.length;
  log(`Batch: ${cities.length} cit${cities.length === 1 ? 'y' : 'ies'} × ${categories.length} categor${categories.length === 1 ? 'y' : 'ies'} = ${totalQueries} queries`);

  // City status book — drives the visual pill row in the popup.
  const cityStatus = cities.map((c) => ({
    full: c.full, city: c.city, region: c.region, country: c.country,
    status: 'pending', kept: 0, scraped: 0,
  }));
  await chrome.storage.local.set({
    batchState: {
      phase: 'running', cities: cityStatus, categories,
      total: totalQueries, index: 0, runningTotal: 0,
      currentCity: '', currentCategory: '', currentQuery: '', ts: Date.now(),
    },
  });

  const all = [];
  const perQuery = []; // {query, scraped, kept}
  let queryIdx = 0;

  outer:
  for (let ci = 0; ci < cities.length; ci++) {
    const cityObj = cities[ci];
    cityStatus[ci].status = 'processing';
    await chrome.storage.local.set({
      batchState: {
        phase: 'running', cities: cityStatus, categories,
        total: totalQueries, index: queryIdx, runningTotal: all.length,
        currentCity: cityObj.full, currentCategory: '', currentQuery: '', ts: Date.now(),
      },
    });
    log(`[city ${ci+1}/${cities.length}] ${cityObj.full}`);

    for (let cati = 0; cati < categories.length; cati++) {
      if (ABORT) { log('Batch stopped.'); break outer; }
      await awaitResume();
      if (ABORT) { log('Batch stopped.'); break outer; }
      const cat = categories[cati];
      const q = `${cat} in ${cityObj.full}`;
      queryIdx++;
      const evtBase = {
        cityIndex: ci, total: totalQueries, index: queryIdx,
        currentCity: cityObj.full, currentCategory: cat, query: q,
        cities: cityStatus, runningTotal: all.length,
      };
      batchEvent({ phase: 'scraping', ...evtBase });
      log(`   [${queryIdx}/${totalQueries}] scraping "${q}"`);

      const { cards, captcha } = await scrapeQueryTab(q);
      if (captcha) {
        log(`⚠️ Google captcha hit on "${q}". Solve it in the open tab, then click Start Batch again.`);
        cityStatus[ci].status = 'error';
        ABORT = true;
        break outer;
      }

      const kept = cards.filter((it) => {
        const r = parseFloat((it.rating || '').toString().replace(',', '.'));
        return !isNaN(r) && r >= 3.5;
      });
      kept.forEach((it) => { it.sourceQuery = q; it.city = cityObj.city; });
      all.push(...kept);
      cityStatus[ci].scraped += cards.length;
      cityStatus[ci].kept    += kept.length;
      perQuery.push({ query: q, scraped: cards.length, kept: kept.length });
      log(`      → ${cards.length} cards, ${kept.length} kept`);

      batchEvent({ phase: 'scraped', ...evtBase, scraped: cards.length, kept: kept.length, runningTotal: all.length });
      await sleep(1500);
    }

    if (cityStatus[ci].status === 'processing') {
      cityStatus[ci].status = 'done';
    }
    await chrome.storage.local.set({
      batchState: {
        phase: 'running', cities: cityStatus, categories,
        total: totalQueries, index: queryIdx, runningTotal: all.length,
        currentCity: '', currentCategory: '', currentQuery: '', ts: Date.now(),
      },
    });
  }

  // Dedupe across all queries by Google place ID, falling back to title+coords.
  const seen = new Set();
  const deduped = [];
  for (const it of all) {
    const m = (it.href || '').match(/!1s([0-9a-fx:]+)/i);
    const key = (m ? m[1].toLowerCase() : '') ||
                ((it.title || '') + '|' + (it.latitude || '') + ',' + (it.longitude || ''));
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(it);
  }
  const dupes = all.length - deduped.length;

  // Convert object rows → 2D rows in BATCH_HEADERS order, save to storage.
  const tableRows = deduped.map((o) => BATCH_KEYS.map((k) => (o[k] != null ? String(o[k]) : '')));
  await chrome.storage.local.set({
    headers: BATCH_HEADERS,
    rows: tableRows,
    progress: 0,
    status: `Batch: ${tableRows.length} unique rows from ${perQuery.length} quer${perQuery.length === 1 ? 'y' : 'ies'} (${dupes} dupes removed)`,
    searchCats: [], // category filter is opt-in only — batch covers many categories
  });

  stopAutoSave();
  // Final save of the deduped set so the recoverable file matches the table.
  await autoSaveNow('final');
  log(`Batch scrape complete: ${tableRows.length} unique rows (${dupes} duplicates removed across queries).`);
  await chrome.storage.local.set({
    batchState: {
      phase: 'done', cities: cityStatus, categories,
      total: totalQueries, index: queryIdx,
      runningTotal: deduped.length, dupes, perQuery, ts: Date.now(),
    },
  });
  batchEvent({ phase: 'done', cities: cityStatus, perQuery, totalKept: deduped.length, dupes });
  tick();

  RUNNING = false;
  if (!ABORT && tableRows.length > 0) {
    log('Starting enrichment on the batch set…');
    await run();
  } else {
    done();
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'START') run();
  if (msg.type === 'STOP')  { ABORT = true; PAUSED = false; stopAutoSave(); }
  if (msg.type === 'PAUSE_BATCH')  { PAUSED = true;  log('⏸ Pause requested.'); }
  if (msg.type === 'RESUME_BATCH') { PAUSED = false; log('▶ Resume requested.'); }
  if (msg.type === 'AUTO_SAVE_NOW') autoSaveNow('manual');
  if (msg.type === 'START_LOCAL_ENRICH') {
    runLocalEnrich(msg.csvText, msg.streamUrl);
  }
  if (msg.type === 'START_BATCH') {
    const cities = Array.isArray(msg.cities) ? msg.cities
      : (msg.location ? [{ city: msg.location, region: '', country: '', full: msg.location }] : []);
    runBatch(cities, msg.categories);
  }
});
