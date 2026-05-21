// Scrapes Instagram, Facebook, WhatsApp links from any hotel website.

function findLinks() {
  const anchors = Array.from(document.querySelectorAll('a[href]'));
  const hrefs = anchors.map((a) => a.href);
  const html = document.documentElement.outerHTML;

  const pick = (re) => {
    for (const h of hrefs) { const m = h.match(re); if (m) return m[0]; }
    const m = html.match(re); return m ? m[0] : '';
  };

  const instagram = pick(/https?:\/\/(www\.)?instagram\.com\/[A-Za-z0-9_.\-\/?=&]+/i);
  const facebook  = pick(/https?:\/\/(www\.|m\.|business\.)?facebook\.com\/[A-Za-z0-9_.\-\/?=&]+/i);
  const whatsapp  = pick(/https?:\/\/(wa\.me|api\.whatsapp\.com\/send|chat\.whatsapp\.com)\/[A-Za-z0-9_.\-\/?=&+]+/i);

  // Prefer og:image / twitter:image; fall back to the largest visible <img>.
  let image = '';
  const meta = document.querySelector('meta[property="og:image"], meta[name="og:image"], meta[name="twitter:image"], meta[property="twitter:image"]');
  if (meta && meta.content) image = meta.content;
  if (!image) {
    const imgs = Array.from(document.images).filter((i) => i.src && i.naturalWidth >= 300);
    imgs.sort((a, b) => (b.naturalWidth * b.naturalHeight) - (a.naturalWidth * a.naturalHeight));
    if (imgs[0]) image = imgs[0].src;
  }
  if (image && image.startsWith('//')) image = location.protocol + image;
  if (image && image.startsWith('/'))  image = location.origin + image;

  const clean = (u) => u.replace(/[)>\]"',]+$/, '');
  return { instagram: clean(instagram), facebook: clean(facebook), whatsapp: clean(whatsapp), image: clean(image) };
}

chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg.type === 'SCRAPE_SITE') {
    setTimeout(() => sendResponse(findLinks()), 500);
    return true;
  }
});
