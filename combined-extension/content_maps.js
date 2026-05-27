// Scrapes Website + Phone from a Google Maps place page sidebar.

function waitFor(predicate, timeout = 10000, interval = 200) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      const v = predicate();
      if (v) return resolve(v);
      if (Date.now() - start > timeout) return resolve(null);
      setTimeout(tick, interval);
    };
    tick();
  });
}

function upgradeGoogleImg(url) {
  if (!url) return url;
  if (/googleusercontent\.com|ggpht\.com/.test(url)) {
    // Force a large size. URLs end in a size token like =w114-h86-k-no, =s86,
    // =w408-h272-k-no-pi... — replace it; if none present, append one.
    return /=[^/]*$/.test(url)
      ? url.replace(/=[^/]*$/, '=w2048-h1536-k-no')
      : url + '=w2048-h1536-k-no';
  }
  return url;
}

// Score a candidate photo URL: real Google place photos (lh3.../p/ or gps-cs-s)
// are full-res; generic profile/avatar URLs (=s44, a-/AC...) are tiny.
function imgScore(url) {
  if (!url) return -1;
  let s = 0;
  if (/googleusercontent\.com\/(p|gps-cs|gps-proxy)/.test(url)) s += 100;
  else if (/googleusercontent\.com|ggpht\.com/.test(url)) s += 40;
  const wm = url.match(/[=&]w(\d+)/); if (wm) s += Math.min(50, parseInt(wm[1], 10) / 40);
  if (/=s\d/.test(url) && !/=w/.test(url)) s -= 30; // square avatar token
  if (/\/a-?\//.test(url) || /=s(32|44|48|64|72|96)\b/.test(url)) s -= 60; // user avatars
  return s;
}

function scrape() {
  let website = '', phone = '', image = '', address = '', category = '';

  // Authoritative address from the place panel.
  const addrEl = document.querySelector('button[data-item-id="address"], [data-item-id="address"]');
  if (addrEl) {
    const lbl = addrEl.getAttribute('aria-label') || addrEl.textContent || '';
    address = lbl.replace(/^Address:\s*/i, '').trim();
  }

  // Category / industry — the small button under the title.
  const catEl = document.querySelector('button[jsaction*="category"], button[jsaction*="pane.rating.category"]');
  if (catEl) category = (catEl.textContent || '').trim();


  const candidates = new Set();
  // DOM sources
  document.querySelectorAll(
    'button[jsaction*="heroHeaderImage"] img, button[aria-label^="Photo of"] img, ' +
    'img[src*="googleusercontent.com"], img[src*="ggpht.com"], ' +
    'div[role="img"][style*="background-image"], button[style*="background-image"], a[style*="background-image"]'
  ).forEach((el) => {
    if (el.tagName === 'IMG' && el.src) candidates.add(el.src);
    else {
      const bg = el.getAttribute('style') || '';
      const m = bg.match(/url\(["']?(https?:[^"')]+)/);
      if (m) candidates.add(m[1]);
    }
  });
  // The place page embeds many photo URLs in inline scripts — always present.
  const html = document.documentElement.innerHTML;
  const re = /https:\/\/(?:lh\d+\.googleusercontent\.com\/(?:p|gps-cs-s|gps-proxy)\/[A-Za-z0-9_\-]+|streetviewpixels[^"\\\s]+)[^"\\\s]*/g;
  let mm; let count = 0;
  while ((mm = re.exec(html)) && count < 50) { candidates.add(mm[0]); count++; }

  // Pick the highest-scoring candidate, then force high-res.
  let best = '', bestScore = -1;
  candidates.forEach((u) => { const sc = imgScore(u); if (sc > bestScore) { bestScore = sc; best = u; } });
  image = upgradeGoogleImg(best);

  // Amenities — Maps shows these as chips/list items in the sidebar with
  // an icon + label. Match against a known set of labels found in the
  // full sidebar text. Case-insensitive, deduplicated, comma-joined.
  const AMENITY_TERMS = [
    'Free Wi-Fi','Wi-Fi','Free breakfast','Breakfast','Air-conditioned','Air conditioning',
    'Pool','Outdoor pool','Indoor pool','Hot tub','Spa','Gym','Fitness center',
    'Free parking','Paid parking','Parking','Airport shuttle','Free airport shuttle',
    'Pet-friendly','Pets allowed','Smoke-free','Smoke-free property',
    'Restaurant','Bar','Room service','Laundry service','Laundry',
    'Beach access','Beachfront','Family rooms','Kid-friendly','Kids stay free',
    'Wheelchair accessible','Wheelchair accessible entrance','Wheelchair accessible parking',
    'Wheelchair accessible elevator','Wheelchair accessible restroom',
    'EV charger','Bicycle rental','Business center','Conference rooms',
    'Hot breakfast','Free continental breakfast','24-hour front desk','Concierge',
    'Non-smoking rooms','Balcony','Sea view','Garden','Kitchen','Kitchenette',
    'Washing machine','Dryer','Refrigerator','Microwave','Coffee maker',
    'Crib','Accessible','Outdoor seating'
  ];
  let amenities = '';
  const main = document.querySelector('[role="main"]');
  if (main) {
    // Source: aria-labels on amenity chips/buttons/icons only. This avoids
    // false positives from review snippets that mention "pool" or "breakfast"
    // in passing. Cap label length to skip long review aria-labels.
    const labels = [];
    main.querySelectorAll('[aria-label]').forEach((el) => {
      const lbl = el.getAttribute('aria-label');
      if (lbl && lbl.length > 0 && lbl.length <= 80) labels.push(lbl);
    });
    const text = labels.join(' · ');
    const found = new Set();
    for (const term of AMENITY_TERMS) {
      const re = new RegExp('(^|[^A-Za-z])' + term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^A-Za-z])', 'i');
      if (re.test(text)) found.add(term);
    }
    // Drop redundant generic terms when a more specific one is present.
    if (found.has('Free Wi-Fi')) found.delete('Wi-Fi');
    if (found.has('Free breakfast')) found.delete('Breakfast');
    if (found.has('Free parking')) found.delete('Parking');
    if (found.has('Free airport shuttle')) found.delete('Airport shuttle');
    if (found.has('Air-conditioned')) found.delete('Air conditioning');
    amenities = Array.from(found).join(', ');
  }
  const wEl = document.querySelector('a[data-item-id="authority"], a[data-item-id^="authority"]');
  if (wEl) website = wEl.href || wEl.getAttribute('aria-label') || '';
  const pEl = document.querySelector('button[data-item-id^="phone:tel:"], [data-item-id^="phone:tel:"]');
  if (pEl) {
    const id = pEl.getAttribute('data-item-id') || '';
    const m = id.match(/^phone:tel:(.+)$/);
    if (m) phone = m[1];
    if (!phone) {
      const lab = pEl.getAttribute('aria-label') || pEl.textContent || '';
      const m2 = lab.match(/[\d+\-\s()]{7,}/);
      if (m2) phone = m2[0].trim();
    }
  }
  return { website, phone, image, amenities, address, category };
}

chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg.type === 'SCRAPE_MAPS') {
    waitFor(() => {
      const d = scrape();
      const sidebarLoaded = !!document.querySelector('[role="main"] h1, [data-item-id]');
      return (d.website || d.phone || d.image || d.amenities || d.address || d.category || sidebarLoaded) ? d : null;
    }, 10000).then((d) => sendResponse(d || { website: '', phone: '', image: '', amenities: '', address: '', category: '' }));
    return true;
  }
});
