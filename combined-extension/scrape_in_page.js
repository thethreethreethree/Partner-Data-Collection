// Injected into a Google Maps SEARCH page via chrome.scripting.executeScript
// (from popup.js for single mode, or from background.js for batch mode).
//
// Wrapped as an async IIFE so executeScript can read the resolved value
// off the last evaluated expression. Returns an array of card objects.

(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  console.log('[DCS] scrape_in_page.js starting');

  // 1) Wait up to 15s for the results panel to render.
  let feed = null;
  for (let i = 0; i < 30; i++) {
    feed = document.querySelector('[role="feed"]') ||
           document.querySelector('div[role="feed"]') ||
           document.querySelector('a[href^="https://www.google.com/maps/place"]')
             ?.closest('div[style*="overflow"], div[tabindex]');
    if (feed) break;
    await sleep(500);
  }
  console.log('[DCS] feed found:', !!feed, feed);

  if (feed) {
    // Collect every plausibly-scrollable container so we scroll all of them
    // each iteration (Maps' DOM has changed over time and parents/children
    // may be the actual scroll container).
    const scrollTargets = new Set([feed]);
    let p = feed.parentElement;
    let hops = 0;
    while (p && hops < 6) {
      const cs = getComputedStyle(p);
      if (/auto|scroll/.test(cs.overflowY || '')) scrollTargets.add(p);
      p = p.parentElement; hops++;
    }
    console.log('[DCS] scroll targets:', scrollTargets.size);

    // PRIMARY exit condition: "You've reached the end of the list." text appears.
    // Stable-iterations is only a far-fallback safety net (~75 seconds of true
    // silence) so we don't give up early on slow / throttled load-more responses.
    let lastCount = 0;
    let stable = 0;
    const HARD_CAP = 500;
    for (let i = 0; i < HARD_CAP; i++) {
      // Aggressive multi-trigger scroll: scrollTop, scrollIntoView, scroll event,
      // wheel event. The 'scroll' Event wake-up is the key one because Google's
      // load-more uses IntersectionObservers that listen for scroll events.
      for (const t of scrollTargets) {
        t.scrollTop = t.scrollHeight;
        try { t.dispatchEvent(new Event('scroll', { bubbles: true })); } catch {}
        try {
          t.dispatchEvent(new WheelEvent('wheel', {
            deltaY: 3000, bubbles: true, cancelable: true,
          }));
        } catch {}
      }
      const cards = feed.querySelectorAll('a[href^="https://www.google.com/maps/place"]');
      const last = cards[cards.length - 1];
      if (last) {
        try { last.scrollIntoView({ block: 'end', behavior: 'instant' }); } catch {}
      }
      // Yield two animation frames so IntersectionObservers run, then breathe.
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      await sleep(2500);

      const count = feed.querySelectorAll('a[href^="https://www.google.com/maps/place"]').length;
      const text = feed.innerText || '';
      // PRIMARY: stop when Maps explicitly says we've reached the end.
      const end =
        /you('|’)?ve reached the end of the list/i.test(text) ||
        /you('|’)?ve reached the end/i.test(text) ||
        /end of (the )?list/i.test(text) ||
        /no more results/i.test(text);

      if (count === lastCount) stable++; else stable = 0;
      console.log(`[DCS] iter ${i}: cards=${count}, stable=${stable}, end=${end}`);
      lastCount = count;

      if (end) {
        console.log('[DCS] ✓ "You\'ve reached the end of the list" detected — stopping cleanly');
        break;
      }
      // Safety fallback only — 30 stable iterations = 75 seconds of no growth.
      // This is the "Google won't load more no matter what" escape hatch.
      if (stable >= 30) {
        console.log('[DCS] ⚠ 30 stable iterations (~75s no growth) — fallback stop. End-of-list never appeared. Google may have rate-limited or the query truly has no more results.');
        break;
      }
    }
    console.log('[DCS] final card count:', lastCount);
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
