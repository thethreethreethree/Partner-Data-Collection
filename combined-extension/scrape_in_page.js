// Injected into a Google Maps SEARCH page via chrome.scripting.executeScript
// (from popup.js for single mode, or from background.js for batch mode).
//
// Wrapped as an async IIFE so executeScript can read the resolved value
// off the last evaluated expression. Returns an array of card objects.

(async () => {
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
      const isPlaceholder = (src) =>
        !src ||
        /ssl\.gstatic\.com\/local\/servicebusiness|default_user\.png|maps\/api\/staticmap/i.test(src) ||
        /(^|\/)a-?\//.test(src) || /=s(32|44|48|64|72|96)\b/.test(src);
      const imgs = Array.from(container.querySelectorAll('img[src^="http"]'));
      const real = imgs.find((el) => !isPlaceholder(el.src) && /googleusercontent\.com|ggpht\.com/.test(el.src))
                || imgs.find((el) => !isPlaceholder(el.src));
      if (real) image = real.src;
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
})();
