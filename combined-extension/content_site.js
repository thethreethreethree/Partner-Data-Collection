// Scrapes Instagram, Facebook, WhatsApp links from any hotel website.

// Reject generic Instagram paths that aren't a profile.
function validIg(url) {
  const m = (url || '').match(/instagram\.com\/([^\/?#]+)/i);
  if (!m) return false;
  const bad = ['p','explore','reel','reels','accounts','about','directory','tv','stories','sharer'];
  return !bad.includes(m[1].toLowerCase());
}

function findLinks() {
  const anchors = Array.from(document.querySelectorAll('a[href]'));
  let hrefs = anchors.map((a) => a.href);

  // JSON-LD sameAs[] is the most reliable source — many sites list their socials here.
  const ldUrls = [];
  document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
    try {
      const data = JSON.parse(s.textContent);
      const walk = (o) => {
        if (!o || typeof o !== 'object') return;
        if (Array.isArray(o)) return o.forEach(walk);
        if (o.sameAs) [].concat(o.sameAs).forEach((u) => typeof u === 'string' && ldUrls.push(u));
        Object.values(o).forEach(walk);
      };
      walk(data);
    } catch {}
  });
  // Also any social meta tags.
  document.querySelectorAll('meta[content*="instagram.com"], meta[content*="facebook.com"]').forEach((m) => {
    if (m.content) ldUrls.push(m.content);
  });

  hrefs = ldUrls.concat(hrefs); // prefer structured data
  const html = document.documentElement.outerHTML;

  const pick = (re, validate) => {
    for (const h of hrefs) { const m = h.match(re); if (m && (!validate || validate(m[0]))) return m[0]; }
    const m = html.match(re); return (m && (!validate || validate(m[0]))) ? m[0] : '';
  };

  const instagram = pick(/https?:\/\/(www\.)?instagram\.com\/[A-Za-z0-9_.\-\/?=&]+/i, validIg);
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
