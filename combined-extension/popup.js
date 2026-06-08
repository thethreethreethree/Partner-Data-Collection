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
  'nightlife','nightclub','night club','club','lounge','disco',
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

const HEADERS = ['Title','Rating','Reviews','Phone','WhatsApp','Instagram','Facebook','Industry','Address','Website','Image','Amenities','Pitch','Latitude','Longitude','Google Maps Link','Source Query','City'];
const KEYS    = ['title','rating','reviewCount','phone','whatsapp','instagram','facebook','industry','address','companyUrl','image','amenities','pitch','latitude','longitude','href','sourceQuery','city'];

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

    // --- Batch label (the user-typed dataset/output name, shown wherever
    //     work is happening so you can tell which dataset is being processed) ---
    const batchPill     = document.getElementById('batch-pill');
    const batchPillName = document.getElementById('batch-pill-name');
    const enrichBatch   = document.getElementById('enrich-batch');
    const liveBatch     = document.getElementById('live-batch');
    function syncBatchLabel(raw) {
      const name = (raw || '').trim();
      if (name) {
        batchPillName.textContent = name;
        batchPill.classList.remove('dim');
        enrichBatch.textContent = name; enrichBatch.style.display = 'inline-flex';
        liveBatch.textContent   = name; liveBatch.style.display   = 'inline-flex';
      } else {
        batchPillName.textContent = 'Untitled';
        batchPill.classList.add('dim');
        enrichBatch.style.display = 'none';
        liveBatch.style.display = 'none';
      }
    }
    // Restore saved name, then mirror typing live + persist.
    chrome.storage.local.get('batchName', ({ batchName }) => {
      if (batchName) filenameInput.value = batchName;
      syncBatchLabel(filenameInput.value);
    });
    filenameInput.addEventListener('input', () => {
      const v = filenameInput.value;
      syncBatchLabel(v);
      chrome.storage.local.set({ batchName: v.trim() });
    });

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
        { target: { tabId: currentTab.id }, files: ['scrape_in_page.js'] },
        async function (results) {
          actionButton.textContent = origLabel;
          if (!results || !results[0] || !results[0].result) {
            actionButton.disabled = false; return;
          }
          // scrape_in_page.js now returns { cards, reachedEnd }; tolerate
          // the legacy array shape too just in case.
          const raw = results[0].result;
          const all = Array.isArray(raw) ? raw : (raw && raw.cards) || [];
          // Tag every card with the search query this scrape came from
          // (so single-mode and batch-mode CSVs share the same shape).
          let sourceQuery = '';
          try {
            const m = (currentTab.url || '').match(/\/maps\/search\/([^/?]+)/);
            if (m) sourceQuery = decodeURIComponent(m[1].replace(/\+/g, ' '));
          } catch {}
          all.forEach((it) => { it.sourceQuery = sourceQuery; });
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

    // --- Batch run controls (Country → Region → multi-city) ---
    const batchStartButton  = document.getElementById('batchStartButton');
    const batchPauseButton  = document.getElementById('batchPauseButton');
    const batchStopButton   = document.getElementById('batchStopButton');
    const batchSummary      = document.getElementById('batch-summary');
    const locCountrySel     = document.getElementById('locCountry');
    const locRegionSel      = document.getElementById('locRegion');
    const locAddBtn         = document.getElementById('locAddButton');
    const cityPickerWrap    = document.getElementById('city-picker');
    const cityCheckboxesEl  = document.getElementById('cityCheckboxes');
    const cityAllToggle     = document.getElementById('cityAllToggle');
    const cityProgressWrap  = document.getElementById('city-progress');
    const cityPillsEl       = document.getElementById('cityPills');
    const exportPerCityBtn  = document.getElementById('exportPerCityButton');
    const combineCitiesBtn  = document.getElementById('combineCitiesButton');
    const cityPillsHint     = document.getElementById('city-pills-hint');
    const pillSelection     = new Set(); // city names selected for combine-export
    const batchCatCheckboxes = () => Array.from(document.querySelectorAll('.batch-cat'));
    // Essentials & Services group — scraped in the same batch run, but exported
    // separately and (for the items marked DO NOT COLLECT in the spec) skipped
    // during enrichment to avoid wasting time on Phone/Instagram/Facebook lookups
    // that don't apply to ATMs, banks, gas stations, etc.
    const essentialsCheckboxes = () => Array.from(document.querySelectorAll('.essentials-cat'));
    const combineEssentialsBtn       = document.getElementById('combineEssentialsButton');
    const exportEssentialsPerCityBtn = document.getElementById('exportEssentialsPerCityButton');
    // Lower-cased list of essentials category values, for filtering rows by Source
    // Query at export time and during skip-enrich checks.
    const ESSENTIALS_VALUES = () => essentialsCheckboxes().map((cb) => cb.value.toLowerCase());
    // Extract the category prefix from a Source Query string ("<cat> in <full>").
    const categoryOfSourceQuery = (sq) => {
      const s = (sq || '').toLowerCase();
      const m = s.match(/^(.+?)\s+in\s+/);
      return m ? m[1].trim() : '';
    };
    // True if the row's Source Query category is one of the essentials values.
    const isEssentialsRow = (row, iSrcQuery, essentialsSet) => {
      if (iSrcQuery < 0) return false;
      const cat = categoryOfSourceQuery(row[iSrcQuery]);
      return essentialsSet.has(cat);
    };

    // Locations data: merge bundled JSON with user's custom additions.
    let LOCATIONS = {};
    let COORDS = {}; // city name → {lat, lng, zoom} for geo-anchored URLs
    const LOCATIONS_URL = chrome.runtime.getURL('locations.json');
    const COORDS_URL    = chrome.runtime.getURL('coords.json');
    async function loadLocations() {
      const bundled = await fetch(LOCATIONS_URL).then((r) => r.json()).catch(() => ({}));
      const coordsRaw = await fetch(COORDS_URL).then((r) => r.json()).catch(() => ({}));
      // Strip metadata keys (e.g. "_comment") and any non-object entries.
      COORDS = Object.fromEntries(
        Object.entries(coordsRaw).filter(([k, v]) =>
          !k.startsWith('_') && v && typeof v === 'object' && typeof v.lat === 'number'),
      );
      const { customLocations = {} } = await chrome.storage.local.get('customLocations');
      const merged = JSON.parse(JSON.stringify(bundled));
      for (const country of Object.keys(customLocations)) {
        merged[country] = merged[country] || {};
        for (const region of Object.keys(customLocations[country])) {
          const cur = merged[country][region] || [];
          const add = customLocations[country][region] || [];
          merged[country][region] = Array.from(new Set([...cur, ...add]));
        }
      }
      LOCATIONS = merged;
      populateCountries();
    }

    function populateCountries() {
      const selected = locCountrySel.value;
      locCountrySel.innerHTML = '<option value="">Country…</option>' +
        Object.keys(LOCATIONS).sort().map((c) => `<option value="${c}">${c}</option>`).join('');
      if (selected && LOCATIONS[selected]) locCountrySel.value = selected;
      populateRegions();
    }
    function populateRegions() {
      const country = locCountrySel.value;
      const prev = locRegionSel.value;
      if (!country) {
        locRegionSel.innerHTML = '<option value="">Region…</option>';
        locRegionSel.disabled = true;
        renderCities([]);
        return;
      }
      const regions = Object.keys(LOCATIONS[country] || {}).sort();
      locRegionSel.innerHTML = '<option value="">Region…</option>' +
        regions.map((r) => `<option value="${r}">${r}</option>`).join('');
      locRegionSel.disabled = false;
      if (prev && regions.includes(prev)) locRegionSel.value = prev;
      renderCitiesFromSelection();
    }
    function renderCitiesFromSelection() {
      const country = locCountrySel.value, region = locRegionSel.value;
      if (!country || !region) { renderCities([]); return; }
      const cities = (LOCATIONS[country][region] || []).slice().sort();
      renderCities(cities);
    }
    function renderCities(cities) {
      cityPickerWrap.style.display = cities.length ? 'block' : 'none';
      cityCheckboxesEl.innerHTML = cities.map((city) =>
        `<label class="toggle"><input type="checkbox" class="city-cb" value="${city}"> ${city}</label>`
      ).join('');
      // Restore previously-selected cities for this region.
      chrome.storage.local.get('selectedCities', ({ selectedCities }) => {
        const key = `${locCountrySel.value}|${locRegionSel.value}`;
        const saved = (selectedCities || {})[key] || [];
        const enabled = new Set(saved);
        cityCheckboxesEl.querySelectorAll('.city-cb').forEach((cb) => {
          cb.checked = enabled.has(cb.value);
        });
        updateStartEnabled();
      });
    }
    function selectedCities() {
      return Array.from(cityCheckboxesEl.querySelectorAll('.city-cb'))
        .filter((cb) => cb.checked).map((cb) => cb.value);
    }
    function updateStartEnabled() {
      const anyCategoryChecked =
        batchCatCheckboxes().filter((cb) => cb.checked).length +
        essentialsCheckboxes().filter((cb) => cb.checked).length > 0;
      batchStartButton.disabled = selectedCities().length === 0 || !anyCategoryChecked;
    }
    cityCheckboxesEl.addEventListener('change', async () => {
      const key = `${locCountrySel.value}|${locRegionSel.value}`;
      const cities = selectedCities();
      const { selectedCities: store = {} } = await chrome.storage.local.get('selectedCities');
      store[key] = cities;
      await chrome.storage.local.set({ selectedCities: store });
      cityAllToggle.checked = cities.length > 0 &&
        cities.length === cityCheckboxesEl.querySelectorAll('.city-cb').length;
      updateStartEnabled();
    });
    cityAllToggle.addEventListener('change', () => {
      cityCheckboxesEl.querySelectorAll('.city-cb').forEach((cb) => { cb.checked = cityAllToggle.checked; });
      cityCheckboxesEl.dispatchEvent(new Event('change'));
    });

    // Restore country/region selection across popup opens.
    chrome.storage.local.get(['locCountry','locRegion','batchCats','essentialsCats'], (s) => {
      if (s.batchCats && Array.isArray(s.batchCats) && s.batchCats.length) {
        const enabled = new Set(s.batchCats);
        batchCatCheckboxes().forEach((cb) => { cb.checked = enabled.has(cb.value); });
      }
      // Essentials default to unchecked (the user opts in); only restore checked
      // state if the user has explicitly enabled some before.
      if (s.essentialsCats && Array.isArray(s.essentialsCats)) {
        const enabled = new Set(s.essentialsCats);
        essentialsCheckboxes().forEach((cb) => { cb.checked = enabled.has(cb.value); });
      }
      // After restoring checkboxes, sync the two "Select all" toggles so they
      // reflect the restored state (checked only when every child is checked).
      syncBatchCatAll();
      syncEssentialsAll();
      if (s.locCountry) locCountrySel.value = s.locCountry;
      // Wait for LOCATIONS to load before we can populate regions.
      const tryRestore = () => {
        if (!Object.keys(LOCATIONS).length) return setTimeout(tryRestore, 100);
        populateRegions();
        if (s.locRegion) {
          locRegionSel.value = s.locRegion;
          renderCitiesFromSelection();
        }
      };
      tryRestore();
    });
    locCountrySel.addEventListener('change', () => {
      chrome.storage.local.set({ locCountry: locCountrySel.value, locRegion: '' });
      populateRegions();
    });
    locRegionSel.addEventListener('change', () => {
      chrome.storage.local.set({ locRegion: locRegionSel.value });
      renderCitiesFromSelection();
    });
    const batchCatAllToggle    = document.getElementById('batchCatAllToggle');
    const essentialsAllToggle  = document.getElementById('essentialsAllToggle');
    // Keep the "Select all" toggle reflecting reality — checked only when every
    // child checkbox in its group is checked. Same pattern as cityAllToggle.
    function syncBatchCatAll() {
      const all = batchCatCheckboxes();
      const on  = all.filter((cb) => cb.checked).length;
      batchCatAllToggle.checked = all.length > 0 && on === all.length;
    }
    function syncEssentialsAll() {
      const all = essentialsCheckboxes();
      const on  = all.filter((cb) => cb.checked).length;
      essentialsAllToggle.checked = all.length > 0 && on === all.length;
    }
    document.getElementById('batch-cats').addEventListener('change', () => {
      const cats = batchCatCheckboxes().filter((cb) => cb.checked).map((cb) => cb.value);
      chrome.storage.local.set({ batchCats: cats });
      syncBatchCatAll();
      updateStartEnabled();
    });
    document.getElementById('batch-essentials').addEventListener('change', () => {
      const cats = essentialsCheckboxes().filter((cb) => cb.checked).map((cb) => cb.value);
      chrome.storage.local.set({ essentialsCats: cats });
      syncEssentialsAll();
      updateStartEnabled();
    });
    batchCatAllToggle.addEventListener('change', () => {
      batchCatCheckboxes().forEach((cb) => { cb.checked = batchCatAllToggle.checked; });
      // Dispatch a change on the container so the existing handler runs (persist + enable).
      document.getElementById('batch-cats').dispatchEvent(new Event('change'));
    });
    essentialsAllToggle.addEventListener('change', () => {
      essentialsCheckboxes().forEach((cb) => { cb.checked = essentialsAllToggle.checked; });
      document.getElementById('batch-essentials').dispatchEvent(new Event('change'));
    });

    // Add custom country / region / city.
    locAddBtn.addEventListener('click', async () => {
      const country = prompt('Country? (leave blank to cancel)')?.trim();
      if (!country) return;
      const region = prompt(`Region in ${country}?`)?.trim();
      if (!region) return;
      const cityList = prompt(`Cities in ${region}? (comma-separated)`)?.trim();
      if (!cityList) return;
      const cities = cityList.split(',').map((c) => c.trim()).filter(Boolean);
      const { customLocations = {} } = await chrome.storage.local.get('customLocations');
      customLocations[country] = customLocations[country] || {};
      const cur = new Set(customLocations[country][region] || []);
      cities.forEach((c) => cur.add(c));
      customLocations[country][region] = [...cur];
      await chrome.storage.local.set({ customLocations });
      await loadLocations();
      locCountrySel.value = country; populateRegions();
      locRegionSel.value = region;   renderCitiesFromSelection();
    });

    loadLocations();

    batchStartButton.addEventListener('click', () => {
      const country = locCountrySel.value, region = locRegionSel.value;
      const cityNames = selectedCities();
      const mainCats       = batchCatCheckboxes().filter((cb) => cb.checked).map((cb) => cb.value);
      const essentialsCats = essentialsCheckboxes().filter((cb) => cb.checked).map((cb) => cb.value);
      // skipEnrichCats: essentials items marked with data-skip-enrich="true".
      // Their values are passed to background so processRow() can skip them
      // during enrichment (no Phone/Instagram/Facebook lookup wasted on ATMs etc.).
      const skipEnrichCats = essentialsCheckboxes()
        .filter((cb) => cb.checked && cb.dataset.skipEnrich === 'true')
        .map((cb) => cb.value);
      // Merge the two groups into one categories array for the scrape pipeline.
      // Background.js treats them uniformly; the only divergence is at export and
      // enrichment time, both of which key off Source Query category.
      const categories = [...mainCats, ...essentialsCats];
      if (!country || !region || cityNames.length === 0) { alert('Pick a country, a region, and at least one city.'); return; }
      if (categories.length === 0) { alert('Pick at least one category.'); return; }
      const cities = cityNames.map((city) => {
        const obj = { city, region, country, full: `${city}, ${region}, ${country}` };
        // Attach coords if we have them — background uses these to build a
        // geo-anchored /maps/search/<query>/@lat,lng,zoom URL.
        const c = COORDS[city];
        if (c) { obj.lat = c.lat; obj.lng = c.lng; obj.zoom = c.zoom || 13; }
        return obj;
      });
      if (!filenameInput.value.trim()) {
        const slug = (cityNames.length === 1 ? cityNames[0] : region).toLowerCase()
          .replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
        filenameInput.value = slug;
        syncBatchLabel(slug);
        chrome.storage.local.set({ batchName: slug });
      }
      resetLivePanel();
      livePhaseEl.textContent = `Batch · ${cities.length} cit${cities.length === 1 ? 'y' : 'ies'} × ${categories.length} categor${categories.length === 1 ? 'y' : 'ies'}`;
      liveCurrent.textContent = 'Starting…';
      batchSummary.textContent = `Starting ${cities.length} cit${cities.length === 1 ? 'y' : 'ies'} × ${categories.length} cats…`;
      batchStartButton.disabled = true;
      batchStopButton.disabled = false;
      enrichPanel.style.display = 'block';
      enrichLog.textContent += `Batch start: ${cities.length} cit${cities.length === 1 ? 'y' : 'ies'} (${cityNames.join(', ')}) × [${categories.join(', ')}]\n`;
      enrichLog.scrollTop = enrichLog.scrollHeight;
      chrome.runtime.sendMessage({ type: 'START_BATCH', cities, categories, skipEnrichCats });
    });

    batchStopButton.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'STOP' });
      batchSummary.textContent = 'Stopping after current query…';
    });

    // Pause/Resume — relies on persisted batchState.paused for label sync,
    // so closing/reopening the popup mid-pause still shows the right state.
    batchPauseButton.addEventListener('click', async () => {
      const { batchState } = await chrome.storage.local.get('batchState');
      const paused = !!(batchState && batchState.paused);
      chrome.runtime.sendMessage({ type: paused ? 'RESUME_BATCH' : 'PAUSE_BATCH' });
      batchPauseButton.textContent = paused ? 'Pause' : 'Resume';
    });

    // --- City status pills ---
    function renderCityPills(cities, opts) {
      if (!cities || !cities.length) {
        cityProgressWrap.style.display = 'none';
        cityPillsEl.innerHTML = '';
        cityPillsHint.style.display = 'none';
        return;
      }
      cityProgressWrap.style.display = 'block';
      // Once the batch is done, pills become click-to-select for the combine export.
      const selectable = !!(opts && opts.selectable);
      cityPillsHint.style.display = selectable ? 'inline' : 'none';
      cityPillsEl.innerHTML = cities.map((c) => {
        const cls = c.status || 'pending';
        const name = c.city || c.full;
        const cnt = (c.status === 'done' || c.status === 'processing') ? `<span class="count">${c.kept || 0}</span>` : '';
        const selClass = selectable ? ' selectable' + (pillSelection.has(name) ? ' selected' : '') : '';
        return `<div class="city-pill ${cls}${selClass}" data-city="${name.replace(/"/g, '&quot;')}">` +
               `<span class="dot"></span><span class="name">${name}</span>${cnt}` +
               `<span class="check">✓</span></div>`;
      }).join('');
    }

    function updateCombineButtonLabel(totalCities) {
      const n = pillSelection.size;
      combineCitiesBtn.textContent = n === 0
        ? `Combine Cities → CSV`
        : (n === totalCities ? `Combine All ${n} → CSV` : `Combine ${n} → CSV`);
    }

    cityPillsEl.addEventListener('click', async (e) => {
      const pill = e.target.closest('.city-pill.selectable');
      if (!pill) return;
      const name = pill.getAttribute('data-city');
      if (!name) return;
      if (pillSelection.has(name)) pillSelection.delete(name);
      else pillSelection.add(name);
      pill.classList.toggle('selected');
      const { batchState } = await chrome.storage.local.get('batchState');
      updateCombineButtonLabel((batchState && batchState.cities && batchState.cities.length) || 0);
    });

    // --- Restore batch dashboard from persisted state on popup open ---
    function applyBatchState(s) {
      if (!s) { cityProgressWrap.style.display = 'none'; return; }
      renderCityPills(s.cities || [], { selectable: s.phase === 'done' });
      if (s.phase === 'running') {
        livePanel.style.display = 'block';
        const idx = s.index || 0;
        const total = s.total || 1;
        const label = s.currentCity ? `${s.currentCategory || ''} in ${s.currentCity}`.trim() : 'Preparing…';
        livePhaseEl.textContent = s.paused
          ? `Batch ⏸ paused at query ${idx + 1}/${total}`
          : `Batch · query ${idx + 1}/${total}`;
        liveCurrent.textContent = s.paused ? `⏸ ${label}` : label;
        liveProg.max = total;
        liveProg.value = idx;
        liveCompletedEl.textContent = String(idx);
        liveFilledEl.textContent    = String(s.runningTotal || 0);
        if (s.paused) {
          batchSummary.textContent = `⏸ Paused · ${s.runningTotal || 0} rows preserved. Click Resume when ready.`;
        } else {
          batchSummary.textContent = idx > 0
            ? `Running · ${idx}/${total} queries · ${s.runningTotal || 0} rows so far`
            : `Starting · ${total} queries across ${(s.cities || []).length} cit${(s.cities || []).length === 1 ? 'y' : 'ies'}`;
        }
        batchStartButton.disabled = true;
        batchPauseButton.disabled = false;
        batchPauseButton.textContent = s.paused ? 'Resume' : 'Pause';
        batchStopButton.disabled  = false;
        exportPerCityBtn.disabled = true;
        combineCitiesBtn.disabled = true;
        combineEssentialsBtn.disabled = true;
        exportEssentialsPerCityBtn.disabled = true;
      } else if (s.phase === 'done') {
        const summary = `${s.runningTotal} unique rows from ${s.total} queries` +
                        (s.dupes ? ` · ${s.dupes} dupes removed` : '');
        batchSummary.textContent = `Last batch: ${summary}`;
        batchStartButton.disabled = false;
        batchPauseButton.disabled = true;
        batchPauseButton.textContent = 'Pause';
        batchStopButton.disabled  = true;
        const hasCities = !!(s.cities && s.cities.length);
        exportPerCityBtn.disabled = !hasCities;
        combineCitiesBtn.disabled = !hasCities;
        combineEssentialsBtn.disabled = !hasCities;
        exportEssentialsPerCityBtn.disabled = !hasCities;
        updateCombineButtonLabel((s.cities || []).length);
      }
    }
    chrome.storage.local.get('batchState', ({ batchState }) => applyBatchState(batchState));
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.batchState) applyBatchState(changes.batchState.newValue);
      if (changes.lastAutoSave && changes.lastAutoSave.newValue) {
        const s = changes.lastAutoSave.newValue;
        enrichLog.textContent += `💾 Auto-saved ${s.rows} rows → ${s.filename}\n`;
        enrichLog.scrollTop = enrichLog.scrollHeight;
      }
    });

    // --- Helper used by all four export handlers: split rows by City column,
    //     emit one CSV per city. baseName + suffix together form the filename.
    async function downloadPerCity(headers, rows, iCity, baseName, suffix, logLabel) {
      const byCity = new Map();
      for (const r of rows) {
        const c = (r[iCity] || '_unassigned').trim() || '_unassigned';
        if (!byCity.has(c)) byCity.set(c, []);
        byCity.get(c).push(r);
      }
      let i = 0;
      for (const [city, cityRows] of byCity) {
        const slug = city.replace(/[^a-z0-9]+/gi, '_').toLowerCase().slice(0, 60);
        const csv = toCSV([headers, ...cityRows]);
        const blob = new Blob([csv], { type: 'text/csv' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${baseName}_${slug}${suffix}.csv`;
        a.style.display = 'none';
        document.body.appendChild(a);
        // Tiny stagger so Chrome doesn't drop downloads from the same click.
        await new Promise((r) => setTimeout(r, 250 * i++));
        a.click(); a.remove();
      }
      enrichLog.textContent += `Exported ${byCity.size} ${logLabel} CSV${byCity.size === 1 ? '' : 's'}.\n`;
      enrichLog.scrollTop = enrichLog.scrollHeight;
      return byCity.size;
    }

    // --- Export per City (Destinations & Experiences): excludes Essentials rows ---
    exportPerCityBtn.addEventListener('click', async () => {
      const { headers, rows } = await chrome.storage.local.get(['headers','rows']);
      if (!rows || !rows.length) { alert('No rows to export.'); return; }
      const iCity = headers.indexOf('City');
      const iSrc = headers.indexOf('Source Query');
      if (iCity < 0) { alert('No City column in this dataset.'); return; }
      const essentialsSet = new Set(ESSENTIALS_VALUES());
      const mainRows = rows.filter((r) => !isEssentialsRow(r, iSrc, essentialsSet));
      if (!mainRows.length) { alert('No Destinations & Experiences rows to export.'); return; }
      const baseName = (filenameInput.value.trim() || 'batch')
        .replace(/[^a-z0-9_-]+/gi, '_').toLowerCase();
      await downloadPerCity(headers, mainRows, iCity, baseName, '', 'per-city');
    });

    // --- Export per City (Essentials & Services): includes ONLY Essentials rows ---
    exportEssentialsPerCityBtn.addEventListener('click', async () => {
      const { headers, rows } = await chrome.storage.local.get(['headers','rows']);
      if (!rows || !rows.length) { alert('No rows to export.'); return; }
      const iCity = headers.indexOf('City');
      const iSrc = headers.indexOf('Source Query');
      if (iCity < 0) { alert('No City column in this dataset.'); return; }
      const essentialsSet = new Set(ESSENTIALS_VALUES());
      const essRows = rows.filter((r) => isEssentialsRow(r, iSrc, essentialsSet));
      if (!essRows.length) { alert('No Essentials rows to export.'); return; }
      const baseName = (filenameInput.value.trim() || 'batch')
        .replace(/[^a-z0-9_-]+/gi, '_').toLowerCase();
      await downloadPerCity(headers, essRows, iCity, baseName, '_essentials', 'essentials per-city');
    });

    // --- Helper used by both Combine handlers: pill-filter cities, build label,
    //     emit one combined CSV. groupFilter is a predicate applied to rows.
    async function downloadCombined(headers, rows, iCity, groupFilter, baseName, suffix, logKind) {
      const wantAll = pillSelection.size === 0;
      const filtered = (wantAll
        ? rows
        : rows.filter((r) => pillSelection.has((r[iCity] || '').trim()))
      ).filter(groupFilter);
      if (filtered.length === 0) {
        alert(`No ${logKind} rows match the selected cities.${pillSelection.size === 0 ? '' : ' (Did you click pills for a city that has these rows?)'}`);
        return;
      }
      let label;
      if (wantAll) {
        label = 'all_cities';
      } else if (pillSelection.size <= 3) {
        label = [...pillSelection].map((c) => c.replace(/[^a-z0-9]+/gi, '_').toLowerCase()).join('-');
      } else {
        label = `combined_${pillSelection.size}cities`;
      }
      const csv = toCSV([headers, ...filtered]);
      const blob = new Blob([csv], { type: 'text/csv' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${baseName}_${label}${suffix}.csv`;
      a.style.display = 'none';
      document.body.appendChild(a); a.click(); a.remove();
      const cityList = wantAll ? 'all cities' : [...pillSelection].join(', ');
      enrichLog.textContent += `${logKind} combined → ${a.download} (${filtered.length} rows: ${cityList})\n`;
      enrichLog.scrollTop = enrichLog.scrollHeight;
    }

    // --- Combine Cities (Destinations & Experiences): excludes Essentials rows ---
    combineCitiesBtn.addEventListener('click', async () => {
      const { headers, rows } = await chrome.storage.local.get(['headers','rows']);
      if (!rows || !rows.length) { alert('No rows to export.'); return; }
      const iCity = headers.indexOf('City');
      const iSrc = headers.indexOf('Source Query');
      if (iCity < 0) { alert('No City column in this dataset.'); return; }
      const essentialsSet = new Set(ESSENTIALS_VALUES());
      const baseName = (filenameInput.value.trim() || 'batch')
        .replace(/[^a-z0-9_-]+/gi, '_').toLowerCase();
      await downloadCombined(headers, rows, iCity,
        (r) => !isEssentialsRow(r, iSrc, essentialsSet),
        baseName, '', 'Destinations');
    });

    // --- Combine Cities (Essentials & Services): includes ONLY Essentials rows ---
    combineEssentialsBtn.addEventListener('click', async () => {
      const { headers, rows } = await chrome.storage.local.get(['headers','rows']);
      if (!rows || !rows.length) { alert('No rows to export.'); return; }
      const iCity = headers.indexOf('City');
      const iSrc = headers.indexOf('Source Query');
      if (iCity < 0) { alert('No City column in this dataset.'); return; }
      const essentialsSet = new Set(ESSENTIALS_VALUES());
      const baseName = (filenameInput.value.trim() || 'batch')
        .replace(/[^a-z0-9_-]+/gi, '_').toLowerCase();
      await downloadCombined(headers, rows, iCity,
        (r) => isEssentialsRow(r, iSrc, essentialsSet),
        baseName, '_essentials', 'Essentials');
    });

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

    // --- Load CSV: import an existing file (e.g. partners_missing_photos.csv)
    //     into the table so it can be re-enriched / pushed / locally-enriched. ---
    const csvFileInput = document.getElementById('csvFileInput');
    document.getElementById('loadCsvButton').addEventListener('click', () => {
      csvFileInput.value = ''; // allow re-picking the same file
      csvFileInput.click();
    });
    csvFileInput.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = parseCSV(text).filter((r) => r.some((v) => (v || '').length));
        if (parsed.length < 2) { alert('CSV looks empty.'); return; }
        const newHeaders = parsed.shift();
        const newRows = parsed.map((r) => {
          const o = new Array(newHeaders.length).fill('');
          for (let i = 0; i < r.length && i < newHeaders.length; i++) o[i] = r[i] ?? '';
          return o;
        });

        // Derive a batch name from the filename (strip ".csv").
        const batchName = file.name.replace(/\.csv$/i, '');
        filenameInput.value = batchName;
        syncBatchLabel(batchName);

        await chrome.storage.local.set({
          headers: newHeaders,
          rows: newRows,
          progress: 0,
          status: `${newRows.length} rows loaded from ${file.name}`,
          searchCats: [],          // no Maps query context for an imported file
          batchName,
        });

        // Refresh UI: render table, show summary, enable downstream actions.
        renderTable(newHeaders, newRows);
        const sumEl = document.getElementById('summary');
        sumEl.style.display = 'block';
        sumEl.innerHTML =
          '<h3>Imported</h3>' +
          '<div class="stat-row">' +
            `<div class="stat"><span class="stat-label">Source</span><span class="stat-value" style="font-size:14px; font-family:ui-monospace,monospace; word-break:break-all;">${file.name}</span></div>` +
            `<div class="stat"><span class="stat-label">Rows</span><span class="stat-value">${newRows.length}</span></div>` +
            `<div class="stat"><span class="stat-label">Columns</span><span class="stat-value">${newHeaders.length}</span></div>` +
          '</div>';

        downloadCsvBtn.disabled = newRows.length === 0;
        enrichButton.disabled   = newRows.length === 0;
        runLocalScraperButton.disabled = newRows.length === 0;
        const { adminApiUrl, adminApiToken } = await chrome.storage.local.get(['adminApiUrl','adminApiToken']);
        pushAdminButton.disabled = !adminApiUrl || !adminApiToken || newRows.length === 0;

        enrichPanel.style.display = 'block';
        enrichLog.textContent += `Loaded ${newRows.length} rows from ${file.name}.\n`;
        enrichLog.scrollTop = enrichLog.scrollHeight;
      } catch (err) {
        alert('Failed to parse CSV: ' + err.message);
      }
    });

    // --- Local enrichment now runs entirely in the background service worker
    //     so closing/minimizing the popup doesn't kill the streaming connection.
    //     We just send a START_LOCAL_ENRICH message and watch storage for state.
    const localPauseButton  = document.getElementById('localPauseButton');
    const savePartialButton = document.getElementById('savePartialButton');

    function currentLocalBase() {
      // Live read — user can change it in settings without reload.
      return (localScraperUrlInput.value || DEFAULT_LOCAL_URL).trim()
        .replace(/\/scrape-instagram(-stream)?$/, '');
    }

    // Pause / Resume — always bound; reads paused state from server.
    let localPausedView = false;
    localPauseButton.addEventListener('click', async () => {
      const base = currentLocalBase();
      const ep = localPausedView ? '/resume-scrape' : '/pause-scrape';
      try {
        await fetch(base + ep, { method: 'POST' });
        localPausedView = !localPausedView;
        localPauseButton.textContent = localPausedView ? 'Resume Local' : 'Pause Local';
        enrichLog.textContent += localPausedView
          ? `⏸ Pause requested. Server halts after the current row. Partial CSV saved to data/_local_enrichment.partial.csv every ~5s.\n`
          : `▶ Resume requested.\n`;
        enrichLog.scrollTop = enrichLog.scrollHeight;
      } catch (e) {
        enrichLog.textContent += `⚠️ Pause toggle failed: ${e.message}\n`;
      }
    });

    // Save Partial — always bound; pulls server's in-memory CSV anytime.
    savePartialButton.addEventListener('click', async () => {
      try {
        const r = await fetch(currentLocalBase() + '/dump-current');
        const csv = await r.text();
        if (!csv || csv.length < 20) { alert('Server has no snapshot yet (run hasn\'t produced data).'); return; }
        const baseName = (filenameInput.value.trim() || 'local_enrichment')
          .replace(/[^a-z0-9_-]+/gi, '_').toLowerCase();
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const blob = new Blob([csv], { type: 'text/csv' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${baseName}_partial_${ts}.csv`;
        a.style.display = 'none';
        document.body.appendChild(a); a.click(); a.remove();
        enrichLog.textContent += `💾 Saved partial snapshot → ${a.download}\n`;
        enrichLog.scrollTop = enrichLog.scrollHeight;
      } catch (e) {
        alert(`Couldn't reach local server: ${e.message}`);
      }
    });

    // Apply localEnrichState → live panel. Restores after popup reopen and
    // updates while the popup is open via chrome.storage.onChanged.
    function applyLocalEnrichState(s) {
      if (!s) return;
      enrichPanel.style.display = 'block';
      livePanel.style.display = 'block';
      const phaseLabel = s.sub === 'igposts'
        ? `Collecting IG posts · ${s.completed}/${s.total}`
        : `Finding Instagram handles · ${s.completed}/${s.total}`;
      if (s.phase === 'running' || s.phase === 'starting') {
        livePhaseEl.textContent = phaseLabel;
        liveCurrent.textContent = s.currentName || 'Starting…';
        liveProg.max = s.total || 1;
        liveProg.value = s.completed || 0;
        liveCompletedEl.textContent = String(s.completed || 0);
        liveFilledEl.textContent    = String(s.filled || 0);
        liveMissedEl.textContent    = String(s.missed || 0);
        livePostsEl.textContent     = String(s.postsCount || 0);
        runLocalScraperButton.disabled = true;
        localPauseButton.disabled  = false;
      } else if (s.phase === 'done') {
        const sum = s.summary || {};
        livePhaseEl.textContent = `Done · filled ${sum.filled || 0} new IG handles` +
          (sum.loggedIn ? `, posts for ${sum.posts || 0} accounts` : ', posts skipped (not logged in)');
        liveCurrent.textContent = '✓ Complete';
        liveProg.value = liveProg.max;
        runLocalScraperButton.disabled = false;
        localPauseButton.disabled = true;
        localPausedView = false;
        localPauseButton.textContent = 'Pause Local';
      } else if (s.phase === 'error') {
        livePhaseEl.textContent = `Error: ${s.error || 'unknown'}`;
        liveCurrent.textContent = '⚠️ Stopped';
        runLocalScraperButton.disabled = false;
        localPauseButton.disabled = true;
      }
    }
    chrome.storage.local.get('localEnrichState', ({ localEnrichState }) =>
      applyLocalEnrichState(localEnrichState));
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.localEnrichState) {
        applyLocalEnrichState(changes.localEnrichState.newValue);
      }
    });

    runLocalScraperButton.addEventListener('click', async () => {
      const { headers, rows, localScraperUrl } =
        await chrome.storage.local.get(['headers','rows','localScraperUrl']);
      if (!rows || !headers || rows.length === 0) { alert('No rows to enrich.'); return; }
      const baseUrl = (localScraperUrl || DEFAULT_LOCAL_URL).trim();
      const streamUrl = baseUrl.replace(/\/scrape-instagram(-stream)?$/, '/scrape-instagram-stream');
      const csvIn = toCSV([headers, ...rows]);
      resetLivePanel();
      enrichPanel.style.display = 'block';
      enrichLog.textContent += `Sending ${rows.length} rows to background worker → ${streamUrl}\n`;
      enrichLog.scrollTop = enrichLog.scrollHeight;
      runLocalScraperButton.disabled = true;
      localPauseButton.disabled = false;
      chrome.runtime.sendMessage({ type: 'START_LOCAL_ENRICH', csvText: csvIn, streamUrl });
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
      // Preserve user configuration across data clears. Form selections (country,
      // region, city checkboxes, category checkboxes, filename) and user-added
      // locations are configuration, not data — they should survive a "clear data"
      // action so the user doesn't have to re-pick everything on every new search.
      const keep = await chrome.storage.local.get([
        'adminApiUrl','adminApiToken','adminRegionId','autoEnrich',
        'locCountry','locRegion','selectedCities','batchCats','essentialsCats','batchName',
        'customLocations','searchCats',
      ]);
      await chrome.storage.local.clear();
      await chrome.storage.local.set(keep);
      renderTable(HEADERS, []);
      const sumEl = document.getElementById('summary');
      sumEl.style.display = 'none'; sumEl.innerHTML = '';
      enrichPanel.style.display = 'none';
      enrichProg.value = 0; enrichProg.max = 1;
      enrichStatus.textContent = 'Idle';
      enrichLog.textContent = '';
      batchSummary.textContent = 'No batch running.';
      livePanel.style.display = 'none';
      pillSelection.clear();
      downloadCsvBtn.disabled = true;
      enrichButton.disabled = true;
      stopButton.disabled = true;
      runLocalScraperButton.disabled = true;
      // Filename input + batch label intentionally NOT cleared — batchName is
      // preserved in storage above and the visible UI should reflect it.
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
        batchStartButton.disabled = false;
        batchStopButton.disabled = true;
      } else if (msg.type === 'BATCH') {
        if (msg.phase === 'scraping') {
          livePhaseEl.textContent = `Batch · scraping (${msg.index + 1}/${msg.total})`;
          liveCurrent.textContent = msg.query;
          batchSummary.textContent = `Scraping query ${msg.index + 1} of ${msg.total}: ${msg.query}`;
          pushFeed(`▸ Scraping: ${msg.query}`, 'info');
        } else if (msg.phase === 'scraped') {
          batchSummary.textContent = `Done ${msg.index}/${msg.total} · ${msg.runningTotal} rows so far`;
          liveProg.max = msg.total;
          liveProg.value = msg.index;
          liveCompletedEl.textContent = String(msg.index);
          liveFilledEl.textContent    = String(msg.runningTotal);
          pushFeed(`   → ${msg.scraped} cards, ${msg.kept} kept`, msg.kept ? 'ok' : 'miss');
        } else if (msg.phase === 'done') {
          const summary = `${msg.totalKept} unique rows from ${msg.perQuery.length} quer${msg.perQuery.length === 1 ? 'y' : 'ies'}` +
                          (msg.dupes ? ` · ${msg.dupes} dupes removed` : '');
          batchSummary.textContent = summary;
          livePhaseEl.textContent = `Batch scrape complete — ${summary}. Enriching…`;
          liveCurrent.textContent = '✓ All queries scraped';
          pushFeed(`✓ ${summary}`, 'ok');
        }
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

// scrapeData lives in scrape_in_page.js — popup and background share it.
