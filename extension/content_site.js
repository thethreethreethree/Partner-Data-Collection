// Scrapes Instagram, Facebook, and WhatsApp links from any hotel website.

function findLinks() {
  const anchors = Array.from(document.querySelectorAll('a[href]'));
  const hrefs = anchors.map(a => a.href);

  // Also scan raw HTML for href-less mentions (e.g., text "wa.me/...").
  const html = document.documentElement.outerHTML;

  const pick = (re) => {
    for (const h of hrefs) { const m = h.match(re); if (m) return m[0]; }
    const m = html.match(re); return m ? m[0] : '';
  };

  const instagram = pick(/https?:\/\/(www\.)?instagram\.com\/[A-Za-z0-9_.\-\/?=&]+/i);
  const facebook  = pick(/https?:\/\/(www\.|m\.|business\.)?facebook\.com\/[A-Za-z0-9_.\-\/?=&]+/i);
  let whatsapp =
       pick(/https?:\/\/(wa\.me|api\.whatsapp\.com\/send|chat\.whatsapp\.com)\/[A-Za-z0-9_.\-\/?=&+]+/i)
    || '';

  // Strip query params that are just tracking (keep wa.me numbers intact).
  const clean = (u) => u.replace(/[)>\]"',]+$/, '');

  return {
    instagram: clean(instagram),
    facebook:  clean(facebook),
    whatsapp:  clean(whatsapp),
  };
}

chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg.type === 'SCRAPE_SITE') {
    // Tiny delay so client-rendered footers (where socials usually live) have a chance.
    setTimeout(() => sendResponse(findLinks()), 500);
    return true;
  }
});
