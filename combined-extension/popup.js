const PITCH_PROMPT = `Prompt: Add a Friendly Pitch Column to a Hostel/Business CSV
I have a CSV file with business listings (hostels, hotels, restaurants, etc.). The file contains columns like Title, Rating, Reviews count, Amenities, and contact info — but no actual review text or business descriptions.
Please add a new column called Pitch at the end of the file. For each entry:

Search the web for that specific business by name (and location, if available in the data). Use sources like Booking.com, Hostelworld, Tripadvisor, Wanderlog, Google reviews, and the business's own website.
Write a 3-5 sentence Pitch that captures the vibe of the place, grounded in what real guests and the business itself say. Each Pitch should:

Lead with the strongest, most appealing quality (location, atmosphere, standout feature)
Mention specific details that make it memorable (staff names, signature offerings, unique amenities, named pets, themed nights, etc. — whatever guests consistently call out)
Be friendly and inviting in tone, like a recommendation from a well-traveled friend
Frame trade-offs positively (e.g., "quiet escape" instead of "far from town"; "simple budget pick" instead of "basic and run-down")
End with a "best for…" or "ideal if…" line naming the type of traveler it suits
Stay accurate — never invent features or fabricate quotes


For places with very thin online presence (few reviews, no website), write a cautious but still warm Pitch that honestly reflects the low-profile, locally-run feel rather than making things up.
Before starting, confirm the file has no existing description/review text to work from, and tell me roughly how many searches this will involve so I can confirm.
Output: save the updated CSV to a downloadable file with all original columns preserved and the new Pitch column appended at the end.`;

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
    chrome.storage.local.get(['rows','headers','progress','status','autoEnrich'], (s) => {
      if (typeof s.autoEnrich === 'boolean') autoEnrichCb.checked = s.autoEnrich;
      if (s.rows && s.headers) {
        renderTable(s.headers, s.rows);
        downloadCsvBtn.disabled = false;
        enrichButton.disabled = false;
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
      await chrome.storage.local.clear();
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
      const imgEl = container.querySelector('img[src*="googleusercontent.com"], img[src*="ggpht.com"], img[src^="http"]');
      if (imgEl) image = imgEl.src;
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
