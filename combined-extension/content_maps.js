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
  return { website, phone, image };
}

chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg.type === 'SCRAPE_MAPS') {
    waitFor(() => {
      const d = scrape();
      const sidebarLoaded = !!document.querySelector('[role="main"] h1, [data-item-id]');
      return (d.website || d.phone || d.image || sidebarLoaded) ? d : null;
    }, 10000).then((d) => sendResponse(d || { website: '', phone: '', image: '' }));
    return true;
  }
});
