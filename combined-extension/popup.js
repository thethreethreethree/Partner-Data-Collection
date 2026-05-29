const PITCH_PROMPT = `# Pitch Generation — Tiered Research Method (paste this with any tourism/business CSV)

You are filling in a **Pitch** column for a CSV of travel listings (attractions, tours, hotels, restaurants, dive shops, etc.). Read the file, then write one pitch per row using the tiered method below. Preserve all original columns and column order; only populate the Pitch column. Save the result to /mnt/user-data/outputs/ with the same filename, and present it when done.

## How to write each pitch
- 3–6 sentences, ~300–550 characters. Lead with the single strongest, most distinctive thing.
- End every pitch with a "Best for…" or "Ideal for…" line naming who it suits.
- Include concrete, memorable specifics where known: named guides/crew/instructors, signature dishes, crew "team" names, distances, what's included, the actual experience (not adjectives).
- Frame trade-offs honestly but positively. For low ratings or thin reviews, say so plainly ("Honest read: …") rather than overselling.
- Warm, knowledgeable travel-writer voice. No fabrication — if you don't know a specific, don't invent it.

## Tier the rows first, then process
Classify each row before writing, so research effort is spent where it matters:

**Tier 1 — Famous / iconic places** (write from general knowledge, no search needed)
Globally or nationally known landmarks, UNESCO sites, signature natural wonders, famous beaches. If a well-traveled person would already recognize the name, it's Tier 1.

**Tier 2 — Mid-tier with a real footprint** (ONE targeted web search each)
Established businesses with strong ratings and a meaningful review count (rough rule: rating ≥ 4.5 AND reviews ≥ ~150, or otherwise clearly notable). Search once to capture specifics — named staff, what's included, standout dishes, crew names — then write.

**Tier 3 — Tiny / low-profile listings** (no search; write cautiously from metadata)
Small review counts, thin online presence, or generic local operators. Write an honest, warm pitch based only on industry + rating + review count + amenities/address. Reflect the locally-run feel; don't invent features. Acknowledge low ratings or small samples directly.

## Process rules
- Batch the work: do all Tier 1 from knowledge, run Tier 2 searches in groups, then write Tier 3 from metadata.
- Build the pitches in a scratch file keyed by row index, then apply to the CSV in one pass (cast the Pitch column to object/string dtype before writing text into it to avoid pandas float errors).
- Verify at the end: all rows filled, original columns intact, file roundtrips when re-read.
- Commit to finishing the whole file in one go. If the list is very large, keep the search budget lean (Tier 1 and 3 use zero searches; only Tier 2 searches, one per row) so you don't run out partway.

When you start, first read the CSV, report the row count and how many fall into each tier, then proceed.`;

// Category terms we recognize in a Google Maps search query. When the
// user searches "hostels in El Nido", we keep only places whose Industry
// contains "hostel" (and reject hotels, resorts, etc.).
const CATEGORY_TERMS = [
  'hostel','hotel','resort','motel','inn','guesthouse','guest house',
  'bed and breakfast','b&b','apartment','apartelle','villa','cottage','lodge',
  'pension','homestay','campsite','glamping',
  'restaurant','cafe','coffee','bakery','bar','pub','brewery','diner',
  'spa','gym','salon','barber','clinic','dentist','pharmacy',
  'museum','gallery','park','beach','dive shop','tour'
];

function detectQueryCategories(url) {
  if (!url) return [];
  const m = url.match(/\/maps\/search\/([^/?]+)/);
  if (!m) return [];
  const q = decodeURIComponent(m[1].replace(/\+/g, ' ')).toLowerCase();
  return CATEGORY_TERMS.filter((t) => new RegExp('\\b' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + 's?\\b').test(q));
}

function matchesCategory(text, cats) {
  if (!cats.length) return true;
  const blob = (text || '').toLowerCase();
  return cats.some((c) => blob.includes(c));
}

// Lenient scrape-time check: only reject if the card's industry has a
// CONFLICTING category term (e.g. "Restaurant" when we want "hotel").
// Empty / unknown / matching industries pass — enrichment filters strictly.
function conflictsWithCategory(industry, cats) {
  if (!cats.length || !industry) return false;
  const ind = industry.toLowerCase();
  const hasMatch = cats.some((c) => ind.includes(c));
  if (hasMatch) return false;
  const hasOther = CATEGORY_TERMS.some((c) => !cats.includes(c) && ind.includes(c));
  return hasOther;
}

const HEADERS = ['Title','Rating','Reviews','Phone','WhatsApp','Instagram','Facebook','Industry','Address','Website','Image','Amenities','Pitch','Latitude','Longitude','Google Maps Link'];
const KEYS    = ['title','rating','reviewCount','phone','whatsapp','instagram','facebook','industry','address','companyUrl','image','amenities','pitch','latitude','longitude','href'];

document.addEventListener('DOMContentLoaded', function () {
  if (new URLSearchParams(location.search).get('view') === 'tab') {
    document.body.classList.add('tab-view');
  }
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    const currentTab = tabs[0];
    const actionButton    = document.getElementById('actionButton');
    const enrichButton    = document.getElementById('enrichButton');
    const stopButton      = document.getElementById('stopButton');
    const downloadCsvBtn  = document.getElementById('downloadCsvButton');
    const filenameInput   = document.getElementById('filenameInput');
    const autoEnrichCb    = document.getElementById('autoEnrich');
    const resultsTable    = document.getElementById('resultsTable');
    const enrichPanel     = document.getElementById('enrich-panel');
    const enrichStatus    = document.getElementById('enrich-status');
    const enrichProg      = document.getElementById('enrich-prog');
    const enrichLog       = document.getElementById('enrich-log');

    const onMaps = currentTab && currentTab.url && currentTab.url.includes('://www.google.com/maps/search');
    if (onMaps) {
      document.getElementById('message').textContent = "Let's scrape Google Maps!";
      actionButton.disabled = false;
    } else {
      const m = document.getElementById('message');
      m.innerHTML = '';
      const a = document.createElement('a');
      a.href = 'https://www.google.com/maps/search/';
      a.textContent = 'Go to Google Maps Search.';
      a.target = '_blank';
      m.appendChild(a);
      actionButton.style.display = 'none';
      // Still allow enrich + download if we have prior state
    }

    // Restore prior state (so closing/reopening popup keeps the table + enrichment progress)
    chrome.storage.local.get(['rows','headers','progress','status','autoEnrich','adminApiUrl','adminApiToken'], (s) => {
      if (typeof s.autoEnrich === 'boolean') autoEnrichCb.checked = s.autoEnrich;
      if (s.rows && s.headers) {
        renderTable(s.headers, s.rows);
        downloadCsvBtn.disabled = false;
        enrichButton.disabled = false;
        const pushBtn = document.getElementById('pushAdminButton');
        if (pushBtn) pushBtn.disabled = !(s.adminApiUrl && s.adminApiToken);
        enrichPanel.style.display = 'block';
        enrichProg.max = s.rows.length;
        enrichProg.value = s.progress || 0;
        enrichStatus.textContent = s.status || `${s.rows.length} rows ready`;
      }
    });

    autoEnrichCb.addEventListener('change', () => {
      chrome.storage.local.set({ autoEnrich: autoEnrichCb.checked });
    });

    actionButton.addEventListener('click', function () {
      actionButton.disabled = true;
      const origLabel = actionButton.textContent;
      actionButton.textContent = 'Scrolling Maps…';
      chrome.scripting.executeScript(
        { target: { tabId: currentTab.id }, function: scrapeData },
        async function (results) {
          actionButton.textContent = origLabel;
          if (!results || !results[0] || !results[0].result) {
            actionButton.disabled = false; return;
          }
          const all = results[0].result;
          const searchCats = detectQueryCategories(currentTab.url);
          const rated = all.filter((it) => {
            const r = parseFloat((it.rating || '').toString().replace(',', '.'));
            if (isNaN(r) || r < 3.5) return false;
            return !conflictsWithCategory(it.industry, searchCats);
          });
          // Dedupe by Google place ID (from the !1s<hex>:<hex> URL token);
          // fall back to title + coordinates when no place ID is present.
          const seen = new Set();
          const kept = [];
          for (const it of rated) {
            const m = (it.href || '').match(/!1s([0-9a-fx:]+)/i);
            const key = (m ? m[1].toLowerCase() : '') ||
                        ((it.title || '') + '|' + (it.latitude || '') + ',' + (it.longitude || ''));
            if (seen.has(key)) continue;
            seen.add(key);
            kept.push(it);
          }
          const dupsRemoved = rated.length - kept.length;
          await chrome.storage.local.set({ searchCats });
          renderSummary(all, kept, all.length - kept.length);
          if (searchCats.length || dupsRemoved) {
            const sumEl = document.getElementById('summary');
            const bits = [];
            if (searchCats.length) bits.push(`Category filter: <strong>${searchCats.join(', ')}</strong>`);
            if (dupsRemoved) bits.push(`Removed <strong>${dupsRemoved}</strong> duplicate${dupsRemoved === 1 ? '' : 's'}`);
            sumEl.insertAdjacentHTML('beforeend',
              `<div class="muted" style="margin-top:8px;">${bits.join(' · ')}</div>`);
          }

          // Convert kept objects → 2D rows in HEADERS order
          const rows = kept.map((it) => KEYS.map((k) => (it[k] != null ? String(it[k]) : '')));
          await chrome.storage.local.set({
            headers: HEADERS, rows, progress: 0, status: `${rows.length} rows scraped`
          });

          renderTable(HEADERS, rows);
          downloadCsvBtn.disabled = rows.length === 0;
          enrichButton.disabled   = rows.length === 0;
          runLocalScraperButton.disabled = rows.length === 0;
          {
            const { adminApiUrl, adminApiToken } = await chrome.storage.local.get(['adminApiUrl','adminApiToken']);
            const pushBtn = document.getElementById('pushAdminButton');
            if (pushBtn) pushBtn.disabled = rows.length === 0 || !adminApiUrl || !adminApiToken;
          }
          enrichPanel.style.display = 'block';
          enrichProg.max = rows.length || 1;
          enrichProg.value = 0;
          actionButton.disabled = false;

          if (autoEnrichCb.checked && rows.length > 0) startEnrich();
        }
      );
    });

    enrichButton.addEventListener('click', startEnrich);
    stopButton.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'STOP' }));

    // --- Admin push settings (endpoint + token + optional region) ---
    const settingsPanel = document.getElementById('settings-panel');
    const apiUrlInput = document.getElementById('apiUrlInput');
    const apiTokenInput = document.getElementById('apiTokenInput');
    const regionIdInput = document.getElementById('regionIdInput');
    const pushAdminButton = document.getElementById('pushAdminButton');
    const localScraperUrlInput = document.getElementById('localScraperUrlInput');
    const runLocalScraperButton = document.getElementById('runLocalScraperButton');
    const DEFAULT_LOCAL_URL = 'http://localhost:8000/scrape-instagram';

    chrome.storage.local.get(['adminApiUrl','adminApiToken','adminRegionId','localScraperUrl','rows'], (s) => {
      apiUrlInput.value   = s.adminApiUrl   || '';
      apiTokenInput.value = s.adminApiToken || '';
      regionIdInput.value = s.adminRegionId || '';
      localScraperUrlInput.value = s.localScraperUrl || DEFAULT_LOCAL_URL;
      pushAdminButton.disabled = !s.adminApiUrl || !s.adminApiToken;
      runLocalScraperButton.disabled = !s.rows || s.rows.length === 0;
    });

    document.getElementById('settingsButton').addEventListener('click', () => {
      settingsPanel.style.display = settingsPanel.style.display === 'none' ? 'block' : 'none';
    });
    document.getElementById('closeSettingsButton').addEventListener('click', () => {
      settingsPanel.style.display = 'none';
    });
    document.getElementById('saveSettingsButton').addEventListener('click', async () => {
      await chrome.storage.local.set({
        adminApiUrl:   apiUrlInput.value.trim(),
        adminApiToken: apiTokenInput.value.trim(),
        adminRegionId: regionIdInput.value.trim(),
        localScraperUrl: localScraperUrlInput.value.trim() || DEFAULT_LOCAL_URL,
      });
      const { rows } = await chrome.storage.local.get('rows');
      pushAdminButton.disabled = !apiUrlInput.value.trim() || !apiTokenInput.value.trim() || !rows;
      runLocalScraperButton.disabled = !rows || rows.length === 0;
      settingsPanel.style.display = 'none';
      enrichLog.textContent += 'Endpoint settings saved.\n';
    });

    pushAdminButton.addEventListener('click', async () => {
      const { headers, rows, adminApiUrl, adminApiToken, adminRegionId } =
        await chrome.storage.local.get([
          'headers','rows','adminApiUrl','adminApiToken','adminRegionId',
        ]);
      if (!rows || !headers) { alert('No rows to push.'); return; }
      if (!adminApiUrl || !adminApiToken) { alert('Set the admin endpoint and token first (⚙).'); return; }

      const objects = rows.map((r) => {
        const o = {};
        headers.forEach((h, i) => { o[h] = r[i] || ''; });
        return o;
      });

      pushAdminButton.disabled = true;
      const origLabel = pushAdminButton.textContent;
      pushAdminButton.textContent = `Pushing ${objects.length}…`;
      enrichPanel.style.display = 'block';
      enrichLog.textContent += `Pushing ${objects.length} rows to ${adminApiUrl}…\n`;

      try {
        const res = await fetch(adminApiUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer ' + adminApiToken,
          },
          body: JSON.stringify({ rows: objects, region_id: adminRegionId || null }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          enrichLog.textContent += `⚠️ Push failed (${res.status}): ${data.error || res.statusText}\n`;
        } else {
          enrichLog.textContent +=
            `✓ Push complete: accepted=${data.accepted}, skipped=${data.skipped}, ` +
            `errors=${(data.errors || []).length}\n`;
        }
      } catch (e) {
        enrichLog.textContent += `⚠️ Push error: ${e.message}\n`;
      } finally {
        pushAdminButton.textContent = origLabel;
        pushAdminButton.disabled = false;
        enrichLog.scrollTop = enrichLog.scrollHeight;
      }
    });

    // --- Live progress panel handles ---
    const livePanel    = document.getElementById('live-panel');
    const livePhaseEl  = document.getElementById('live-phase');
    const liveCurrent  = document.getElementById('live-current');
    const liveProg     = document.getElementById('live-prog');
    const liveCompletedEl = document.getElementById('live-completed');
    const liveFilledEl    = document.getElementById('live-filled');
    const liveMissedEl    = document.getElementById('live-missed');
    const livePostsEl     = document.getElementById('live-posts');
    const liveFeed     = document.getElementById('live-feed');

    function resetLivePanel() {
      livePanel.style.display = 'block';
      livePhaseEl.textContent = 'Starting…';
      liveCurrent.textContent = '—';
      liveProg.value = 0; liveProg.max = 1;
      liveCompletedEl.textContent = '0';
      liveFilledEl.textContent    = '0';
      liveMissedEl.textContent    = '0';
      livePostsEl.textContent     = '0';
      liveFeed.innerHTML = '';
    }
    function pushFeed(text, cls) {
      const li = document.createElement('li');
      if (cls) li.className = cls;
      li.textContent = text;
      liveFeed.appendChild(li);
      // Keep the last 60 entries; auto-scroll to bottom.
      while (liveFeed.childElementCount > 60) liveFeed.removeChild(liveFeed.firstChild);
      liveFeed.scrollTop = liveFeed.scrollHeight;
    }

    runLocalScraperButton.addEventListener('click', async () => {
      const { headers, rows, localScraperUrl } =
        await chrome.storage.local.get(['headers','rows','localScraperUrl']);
      if (!rows || !headers || rows.length === 0) { alert('No rows to enrich.'); return; }
      const baseUrl = (localScraperUrl || DEFAULT_LOCAL_URL).trim();
      // Force the streaming endpoint regardless of which path the user saved.
      const streamUrl = baseUrl.replace(/\/scrape-instagram(-stream)?$/, '/scrape-instagram-stream');

      const csvIn = toCSV([headers, ...rows]);
      const origLabel = runLocalScraperButton.textContent;
      runLocalScraperButton.disabled = true;
      runLocalScraperButton.textContent = `Enriching ${rows.length}…`;
      resetLivePanel();
      enrichPanel.style.display = 'block';
      enrichLog.textContent +=
        `Streaming ${rows.length} rows from ${streamUrl}…\n`;
      enrichLog.scrollTop = enrichLog.scrollHeight;

      // Live counters
      let total = rows.length;
      let completed = 0, filled = 0, missed = 0, postsCount = 0;
      let phase = 'instagram';
      let finalCsv = null, finalLoggedIn = false, finalErr = null;

      try {
        const res = await fetch(streamUrl, {
          method: 'POST',
          headers: { 'content-type': 'text/csv' },
          body: csvIn,
        });
        if (!res.ok || !res.body) {
          const msg = await res.text().catch(() => res.statusText);
          enrichLog.textContent += `⚠️ Local enricher failed (${res.status}): ${msg}\n`;
          livePhaseEl.textContent = `Error (${res.status})`;
          return;
        }

        // NDJSON: one JSON event per line.
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
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
              total = ev.total || total;
              liveProg.max = total || 1;
              livePhaseEl.textContent = `Finding Instagram handles · ${total} rows`;
              pushFeed(`— Phase: Instagram handles (${total} rows)`, 'info');
            } else if (ev.type === 'ig-row') {
              completed++;
              const handle = (ev.handle || '').match(/instagram\.com\/([^/?#]+)/i)?.[1] || ev.handle;
              if (ev.handle) { filled++; pushFeed(`✓ ${ev.name}  →  @${handle}`, 'ok'); }
              else { missed++; pushFeed(`· ${ev.name}`, 'miss'); }
              liveCurrent.textContent = ev.name;
              liveProg.value = completed;
              liveCompletedEl.textContent = String(completed);
              liveFilledEl.textContent    = String(filled);
              liveMissedEl.textContent    = String(missed);
            } else if (ev.type === 'phase' && ev.phase === 'igposts') {
              phase = 'igposts';
              completed = 0;
              total = ev.total || 0;
              liveProg.max = total || 1; liveProg.value = 0;
              liveCompletedEl.textContent = '0';
              livePhaseEl.textContent = `Collecting IG posts · ${total} accounts`;
              pushFeed(`— Phase: IG posts (${total} accounts with handles)`, 'info');
            } else if (ev.type === 'igposts-row') {
              completed++;
              if (ev.count > 0) postsCount += ev.count;
              liveCurrent.textContent = ev.name;
              liveProg.value = completed;
              liveCompletedEl.textContent = String(completed);
              livePostsEl.textContent     = String(postsCount);
              if (ev.already)        pushFeed(`= ${ev.name} (already had posts)`, 'miss');
              else if (ev.count > 0) pushFeed(`✓ ${ev.name}: ${ev.count} post(s)`, 'ok');
              else                   pushFeed(`· ${ev.name}: no posts`, 'miss');
            } else if (ev.type === 'done') {
              finalCsv = ev.csv; finalLoggedIn = !!ev.loggedIn;
              livePhaseEl.textContent =
                `Done · filled ${ev.filled} new IG handles (${ev.already} already had one)` +
                (ev.loggedIn ? `, posts for ${ev.posts} accounts` : ', posts skipped (not logged in)');
              liveCurrent.textContent = '✓ Complete';
              if (total > 0) { liveProg.value = liveProg.max; }
              break readLoop;
            } else if (ev.type === 'error') {
              finalErr = ev.message;
              livePhaseEl.textContent = `Error: ${ev.message}`;
              liveCurrent.textContent = '⚠️ Stopped';
              break readLoop;
            }
          }
        }

        if (finalErr) {
          enrichLog.textContent += `⚠️ Local enricher error: ${finalErr}\n`;
          return;
        }
        if (!finalCsv) {
          enrichLog.textContent += `⚠️ Stream ended without a 'done' event.\n`;
          return;
        }
        const parsed = parseCSV(finalCsv);
        if (!parsed.length) {
          enrichLog.textContent += `⚠️ Local enricher returned empty CSV.\n`;
          return;
        }
        const newHeaders = parsed.shift();
        const newRows = parsed
          .filter((r) => r.some((v) => (v || '').length))
          .map((r) => {
            const o = new Array(newHeaders.length).fill('');
            for (let i = 0; i < r.length && i < newHeaders.length; i++) o[i] = r[i] ?? '';
            return o;
          });
        await chrome.storage.local.set({ headers: newHeaders, rows: newRows });
        renderTable(newHeaders, newRows);
        enrichLog.textContent +=
          `✓ Local enrichment done: filled ${filled} new IG handles, ${missed} missed.\n` +
          (finalLoggedIn
            ? `   IG posts collected: ${postsCount} thumbnails across ${completed} accounts.\n`
            : `   IG posts skipped (not logged in — run ig-login.mjs in the Experience Organizer folder).\n`);
      } catch (e) {
        enrichLog.textContent +=
          `⚠️ Couldn't reach the local enricher: ${e.message}\n` +
          `   Is the Experience Organizer server running? Double-click start.bat.\n`;
        livePhaseEl.textContent = `Error: ${e.message}`;
        liveCurrent.textContent = '⚠️ Connection failed';
      } finally {
        runLocalScraperButton.textContent = origLabel;
        runLocalScraperButton.disabled = false;
        enrichLog.scrollTop = enrichLog.scrollHeight;
      }
    });

    document.getElementById('generatePitchButton').addEventListener('click', async () => {
      const btn = document.getElementById('generatePitchButton');
      try {
        await navigator.clipboard.writeText(PITCH_PROMPT);
        btn.textContent = 'Copied! Opening Claude…';
      } catch {
        // Fallback for clipboard API failures
        const ta = document.createElement('textarea');
        ta.value = PITCH_PROMPT;
        document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); btn.textContent = 'Copied! Opening Claude…'; }
        catch { btn.textContent = 'Copy failed — opening Claude'; }
        ta.remove();
      }
      chrome.tabs.create({ url: 'https://claude.ai/new', active: true });
      setTimeout(() => { btn.textContent = 'Generate Pitch'; }, 2500);
    });

    document.getElementById('clearButton').addEventListener('click', async () => {
      if (!confirm('Clear all scraped + enriched data? This cannot be undone.')) return;
      chrome.runtime.sendMessage({ type: 'STOP' });
      // Preserve admin endpoint settings (convenience, not data).
      const keep = await chrome.storage.local.get(['adminApiUrl','adminApiToken','adminRegionId','autoEnrich']);
      await chrome.storage.local.clear();
      await chrome.storage.local.set(keep);
      renderTable(HEADERS, []);
      const sumEl = document.getElementById('summary');
      sumEl.style.display = 'none'; sumEl.innerHTML = '';
      enrichPanel.style.display = 'none';
      enrichProg.value = 0; enrichProg.max = 1;
      enrichStatus.textContent = 'Idle';
      enrichLog.textContent = '';
      downloadCsvBtn.disabled = true;
      enrichButton.disabled = true;
      stopButton.disabled = true;
      runLocalScraperButton.disabled = true;
      filenameInput.value = '';
    });

    function startEnrich() {
      enrichButton.disabled = true;
      stopButton.disabled = false;
      chrome.runtime.sendMessage({ type: 'START' });
    }

    downloadCsvBtn.addEventListener('click', async () => {
      const { headers, rows } = await chrome.storage.local.get(['headers','rows']);
      if (!rows) return;
      const csv = toCSV([headers, ...rows]);
      let filename = filenameInput.value.trim();
      filename = filename ? filename.replace(/[^a-z0-9]/gi, '_').toLowerCase() + '.csv' : 'google-maps-data.csv';
      const blob = new Blob([csv], { type: 'text/csv' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.style.display = 'none';
      document.body.appendChild(a); a.click(); a.remove();
    });

    // Messages from background
    chrome.runtime.onMessage.addListener(async (msg) => {
      if (msg.type === 'LOG') {
        enrichLog.textContent += msg.text + '\n';
        enrichLog.scrollTop = enrichLog.scrollHeight;
      } else if (msg.type === 'TICK') {
        const s = await chrome.storage.local.get(['rows','progress','status']);
        enrichProg.max = (s.rows || []).length || 1;
        enrichProg.value = s.progress || 0;
        enrichStatus.textContent = s.status || '';
        // Re-render table to reflect newly filled cells
        renderTable(HEADERS, s.rows || []);
      } else if (msg.type === 'DONE') {
        enrichButton.disabled = false;
        stopButton.disabled = true;
      }
    });

    function renderTable(headers, rows) {
      while (resultsTable.firstChild) resultsTable.removeChild(resultsTable.firstChild);
      const head = document.createElement('tr');
      headers.forEach((h) => { const th = document.createElement('th'); th.textContent = h; head.appendChild(th); });
      resultsTable.appendChild(head);
      rows.forEach((r) => {
        const tr = document.createElement('tr');
        for (let i = 0; i < headers.length; i++) {
          const td = document.createElement('td');
          td.textContent = r[i] || '';
          tr.appendChild(td);
        }
        resultsTable.appendChild(tr);
      });
    }

    function renderSummary(allItems, keptItems, rejected) {
      const el = document.getElementById('summary');
      const ratings = keptItems
        .map((i) => parseFloat((i.rating || '').toString().replace(',', '.')))
        .filter((r) => !isNaN(r));
      const avg = ratings.length ? (ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(2) : '–';
      el.innerHTML =
        '<h3>Scrape Summary</h3>' +
        '<div class="stat-row">' +
          `<div class="stat"><span class="stat-label">Scraped</span><span class="stat-value">${allItems.length}</span></div>` +
          `<div class="stat"><span class="stat-label">Kept (≥3.5★)</span><span class="stat-value">${keptItems.length}</span></div>` +
          `<div class="stat"><span class="stat-label">Rejected</span><span class="stat-value">${rejected}</span></div>` +
          `<div class="stat"><span class="stat-label">Avg rating</span><span class="stat-value">${avg}</span></div>` +
        '</div>';
      el.style.display = 'block';
    }
  });
});

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
      else if (c === '\r') { /* skip */ }
      else cur += c;
    }
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

function toCSV(rows) {
  return rows.map((r) => r.map((v) => {
    v = v == null ? '' : String(v);
    return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  }).join(',')).join('\r\n');
}

// === Runs in the Google Maps search page ===
async function scrapeData() {
  // Auto-scroll the results feed until the list stops growing or Google
  // shows "You've reached the end of the list." — Maps virtualizes the
  // panel, so without this we'd only see the ~20 cards initially rendered.
  const feed = document.querySelector('[role="feed"]');
  if (feed) {
    let lastCount = 0, stable = 0;
    for (let i = 0; i < 120; i++) {
      feed.scrollTop = feed.scrollHeight;
      await new Promise((r) => setTimeout(r, 900));
      const count = feed.querySelectorAll('a[href^="https://www.google.com/maps/place"]').length;
      const end = /you('|’)?ve reached the end of the list/i.test(feed.innerText || '');
      if (count === lastCount) stable++; else stable = 0;
      lastCount = count;
      if (end || stable >= 3) break;
    }
  }

  const links = Array.from(document.querySelectorAll('a[href^="https://www.google.com/maps/place"]'));
  return links.map((link) => {
    const container = link.closest('[jsaction*="mouseover:pane"]');
    const titleText = container ? (container.querySelector('.fontHeadlineSmall')?.textContent || '') : '';
    let rating = '', reviewCount = '', phone = '', industry = '', address = '', companyUrl = '', instagram = '', facebook = '';

    if (container) {
      const roleImg = container.querySelector('[role="img"]');
      if (roleImg) {
        const al = roleImg.getAttribute('aria-label') || '';
        if (al.includes('stars')) {
          const parts = al.split(' ');
          rating = parts[0];
          reviewCount = '(' + parts[2] + ')';
        } else { rating = '0'; reviewCount = '0'; }
      }

      const text = container.textContent || '';
      const addrMatch = text.match(/\d+ [\w\s]+(?:#\s*\d+|Suite\s*\d+|Apt\s*\d+)?/);
      if (addrMatch) {
        address = addrMatch[0];
        const before = text.substring(0, text.indexOf(address)).trim();
        const idx = before.lastIndexOf(rating + reviewCount);
        if (idx !== -1) {
          const raw = before.substring(idx + (rating + reviewCount).length).trim().split(/[\r\n]+/)[0];
          industry = raw.replace(/[·.,#!?]/g, '').trim();
        }
        address = address.replace(/\b(Closed|Open 24 hours|24 hours)|Open\b/g, '').trim()
                         .replace(/(\w)(Open|Closed)/g, '$1').trim();
      }

      const allAnchors = Array.from(container.querySelectorAll('a[href]'));
      const external = allAnchors.filter((a) => !a.href.startsWith('https://www.google.com/maps/place/'));
      if (external.length > 0) companyUrl = external[0].href;
      const ig = allAnchors.find((a) => /(^|\.)instagram\.com\//i.test(a.href));
      if (ig) instagram = ig.href;
      const fb = allAnchors.find((a) => /(^|\.)facebook\.com\//i.test(a.href));
      if (fb) facebook = fb.href;

      const pm = text.match(/(\+\d{1,2}\s)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/);
      phone = pm ? pm[0] : '';
    }

    let image = '';
    if (container) {
      // Walk the card's imgs, skipping Google's default placeholder
      // (default_user.png) and tiny avatar tokens. Prefer real photo CDNs.
      const isPlaceholder = (src) =>
        !src ||
        /ssl\.gstatic\.com\/local\/servicebusiness|default_user\.png|maps\/api\/staticmap/i.test(src) ||
        /(^|\/)a-?\//.test(src) || /=s(32|44|48|64|72|96)\b/.test(src);
      const imgs = Array.from(container.querySelectorAll('img[src^="http"]'));
      const real = imgs.find((el) => !isPlaceholder(el.src) && /googleusercontent\.com|ggpht\.com/.test(el.src))
                || imgs.find((el) => !isPlaceholder(el.src));
      if (real) image = real.src;
      if (image && /googleusercontent\.com|ggpht\.com/.test(image)) {
        image = image.replace(/=[^/?#]+$/, '=w1600-h1200-k-no');
      }
    }

    let latitude = '', longitude = '';
    const pin = link.href.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
    if (pin) { latitude = pin[1]; longitude = pin[2]; }
    else {
      const at = link.href.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
      if (at) { latitude = at[1]; longitude = at[2]; }
    }

    let whatsapp = '';
    if (phone) {
      const digits = phone.replace(/\D/g, '');
      if (digits.length >= 7) whatsapp = 'https://wa.me/' + digits;
    }

    return { title: titleText, rating, reviewCount, phone, whatsapp, instagram, facebook,
             industry, address, companyUrl, image, latitude, longitude, href: link.href };
  });
}
