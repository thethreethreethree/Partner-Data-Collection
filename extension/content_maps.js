// Scrapes website + phone from a Google Maps place page sidebar.
// Google Maps marks key fields with data-item-id:
//   website:  data-item-id="authority"
//   phone:    data-item-id^="phone:tel:"
// Falls back to aria-label parsing.

function waitFor(predicate, timeout = 8000, interval = 200) {
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

function scrape() {
  let website = '';
  let phone = '';

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
  return { website, phone };
}

chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg.type === 'SCRAPE_MAPS') {
    waitFor(() => {
      const d = scrape();
      // resolve as soon as anything appears, or once the sidebar is clearly loaded
      const sidebarLoaded = !!document.querySelector('[role="main"] h1, [data-item-id]');
      return (d.website || d.phone || sidebarLoaded) ? d : null;
    }, 10000).then((d) => sendResponse(d || { website: '', phone: '' }));
    return true; // async
  }
});
