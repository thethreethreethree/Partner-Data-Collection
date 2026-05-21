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
    // Swap size suffix (e.g. =w114-h86-k-no, =s86, =w408-h272-k-no-pi-...) for high-res.
    return url.replace(/=[^/?#]+$/, '=w1600-h1200-k-no');
  }
  return url;
}

function scrape() {
  let website = '', phone = '', image = '';
  // Hero photo on the place page — try img tags, then background-image styles.
  const candidates = Array.from(document.querySelectorAll(
    'button[jsaction*="heroHeaderImage"] img, button[aria-label^="Photo of"] img, ' +
    'img[src*="googleusercontent.com"], img[src*="ggpht.com"], ' +
    'div[role="img"][style*="background-image"], button[style*="background-image"], a[style*="background-image"]'
  ));
  for (const el of candidates) {
    let src = '';
    if (el.tagName === 'IMG') src = el.src;
    else {
      const bg = el.getAttribute('style') || '';
      const m = bg.match(/url\(["']?(https?:[^"')]+)/);
      if (m) src = m[1];
    }
    if (src && /googleusercontent\.com|ggpht\.com/.test(src)) { image = src; break; }
    if (src && !image) image = src; // fallback
  }
  image = upgradeGoogleImg(image);

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
    const text = main.innerText || '';
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
  return { website, phone, image, amenities };
}

chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg.type === 'SCRAPE_MAPS') {
    waitFor(() => {
      const d = scrape();
      const sidebarLoaded = !!document.querySelector('[role="main"] h1, [data-item-id]');
      return (d.website || d.phone || d.image || d.amenities || sidebarLoaded) ? d : null;
    }, 10000).then((d) => sendResponse(d || { website: '', phone: '', image: '', amenities: '' }));
    return true;
  }
});
