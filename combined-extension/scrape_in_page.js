// Injected into a Google Maps SEARCH page via chrome.scripting.executeScript
// (from popup.js for single mode, or from background.js for batch mode).
//
// Wrapped as an async IIFE so executeScript can read the resolved value
// off the last evaluated expression. Returns an array of card objects.

(async () => {
  let reachedEnd = false;
  const feed = document.querySelector('[role="feed"]');
  if (feed) {
    // Try to scroll until "You've reached the end of the list" appears.
    // Capped at 100 iterations (~2.5 min) per attempt — if we haven't hit
    // the end by then, the caller (background.js) will reload + retry.
    let cardCount = 0;
    let stable = 0;
    for (let i = 0; i < 100; i++) {
      feed.scrollTop = feed.scrollHeight;
      await new Promise((r) => setTimeout(r, 1500));
      const newCount = feed.querySelectorAll('a[href^="https://www.google.com/maps/place"]').length;
      const text = feed.innerText || '';
      const end = /you('|’)?ve reached the end of the list/i.test(text) ||
                  /you('|’)?ve reached the end/i.test(text);
      if (end) { reachedEnd = true; cardCount = newCount; break; }
      // Track stalls so the per-attempt loop gives up after a while of
      // true silence rather than spinning 100 iters on nothing.
      if (newCount === cardCount) stable++; else stable = 0;
      cardCount = newCount;
      if (stable >= 15) break; // ~22s of zero growth → bail and let caller retry
    }
    console.log(`[DCS] scroll done: ${cardCount} cards, reachedEnd=${reachedEnd}`);
  }

  const links = Array.from(document.querySelectorAll('a[href^="https://www.google.com/maps/place"]'));
  const cards = links.map((link) => {
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

      // Industry + address parsing. The OLD code required a US-style numbered
      // address (\d+ [\w\s]+) to even attempt extraction, which silently
      // skipped most Filipino / SEA listings (which use Sitio/Barangay, not
      // street numbers). New approach: anchor on the rating string and read
      // forward — the card layout is consistently "<title> <rating><reviews>
      // <industry> <address> Open|Closed …". Splits on linebreaks/middots
      // give us industry first, address after.
      const cleanText = (container.innerText || container.textContent || '').replace(/ /g, ' ');
      const rrToken = (rating || '') + (reviewCount || '');
      if (rrToken) {
        const after = cleanText.indexOf(rrToken);
        if (after !== -1) {
          let tail = cleanText.substring(after + rrToken.length);
          // Trim Open/Closed hours and everything past them — those come AFTER address.
          tail = tail.replace(/\s*(Closes|Closed|Opens|Open(?:s|ed)?(?: \d|\.|\b)|24 hours).*$/is, '').trim();
          // The first line/segment is industry, remaining is address.
          const parts = tail.split(/[\r\n]+|\s+·\s+/).map((s) => s.trim()).filter(Boolean);
          if (parts.length >= 1) industry = parts[0].replace(/[·.,#!?]+$/g, '').trim();
          if (parts.length >= 2) address = parts.slice(1).join(', ').replace(/^[·.,\s]+|[·.,\s]+$/g, '').trim();
        }
      }
      // Fallback for cards that DO have a numbered address — preserves the
      // original behaviour as a backup when the rating-anchored parse misses.
      if (!address) {
        const numMatch = cleanText.match(/\d+\s+[\w\s,]+(?=\s+(?:Open|Closed|·|$))/i);
        if (numMatch) address = numMatch[0].trim();
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
  return { cards, reachedEnd };
})();
