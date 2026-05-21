const HEADERS = ['Title','Rating','Reviews','Phone','WhatsApp','Instagram','Facebook','Industry','Address','Website','Image','Amenities','Latitude','Longitude','Google Maps Link'];
const KEYS    = ['title','rating','reviewCount','phone','whatsapp','instagram','facebook','industry','address','companyUrl','image','amenities','latitude','longitude','href'];

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
      chrome.scripting.executeScript(
        { target: { tabId: currentTab.id }, function: scrapeData },
        async function (results) {
          if (!results || !results[0] || !results[0].result) {
            actionButton.disabled = false; return;
          }
          const all = results[0].result;
          const kept = all.filter((it) => {
            const r = parseFloat((it.rating || '').toString().replace(',', '.'));
            return !isNaN(r) && r >= 3.5;
          });
          renderSummary(all, kept, all.length - kept.length);

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
function scrapeData() {
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
