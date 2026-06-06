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
      // Use a regex anchor instead of literal rating+reviewCount substring
      // match. The old indexOf() failed whenever Maps rendered any whitespace
      // (or a newline) between "4.8" and "(1,578)" — common for accommodation
      // cards. The regex below tolerates that.
      if (rating && rating !== '0') {
        const ratingEsc = rating.replace('.', '\\.');
        const anchor = new RegExp(ratingEsc + '\\s*\\(?\\s*[\\d,]+\\s*\\)?', 'i');
        const am = cleanText.match(anchor);
        if (am) {
          let tail = cleanText.substring(am.index + am[0].length);
          tail = tail.replace(/\s*(Closes|Closed|Opens|Open(?:s|ed)?(?: \d|\.|\b)|24 hours).*$/is, '').trim();
          const parts = tail.split(/[\r\n]+|\s+·\s+/).map((s) => s.trim()).filter(Boolean);
          if (parts.length >= 1) industry = parts[0].replace(/[·.,#!?]+$/g, '').trim();
          if (parts.length >= 2) address = parts.slice(1).join(', ').replace(/^[·.,\s]+|[·.,\s]+$/g, '').trim();
        }
      }
      // Numbered-address fallback for cards where the rating-anchored parse missed.
      if (!address) {
        const numMatch = cleanText.match(/\d+\s+[\w\s,]+(?=\s+(?:Open|Closed|·|$))/i);
        if (numMatch) address = numMatch[0].trim();
      }
      // Title-based fallback for industry — for brand-new listings with no
      // rating yet. Looks for an industry-shaped single line after the title.
      if (!industry) {
        const lines = cleanText.split(/[\r\n]+/).map((s) => s.trim()).filter(Boolean);
        const titleIdx = lines.findIndex((l) => l === titleText);
        if (titleIdx >= 0) {
          for (let k = titleIdx + 1; k < Math.min(lines.length, titleIdx + 4); k++) {
            const l = lines[k];
            if (/^\d|stars?|reviews?|\$|Open|Closed/i.test(l)) continue;
            if (/^[A-Z][A-Za-z\s&\-'/]{2,40}$/.test(l)) { industry = l; break; }
          }
        }
      }
      // Normalize so the CSV has consistent capitalization and collapses
      // Google's verbose variants ("Resort hotel" → "Resort"). Mirrors the
      // canonical normalizer in content_maps.js — duplicated inline here so
      // the batch-scrape industry value is clean before enrichment overrides.
      industry = (function normalize(raw) {
        if (!raw) return '';
        const r = String(raw).trim().replace(/\s+/g, ' '); if (!r) return '';
        const lc = r.toLowerCase();
        const cap = (s) => s.split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
        if (/backpack|^hostel\b/.test(lc)) return 'Hostel';
        if (/resort hotel|^resort\b/.test(lc)) return 'Resort';
        if (/boutique hotel|^hotel\b/.test(lc)) return 'Hotel';
        if (/bed (?:and|&) breakfast|^b&b$/.test(lc)) return 'Bed & Breakfast';
        if (/guest ?house/.test(lc)) return 'Guesthouse';
        if (/pension/.test(lc)) return 'Pension House';
        if (/holiday apartment|apartment rental/.test(lc)) return 'Apartment Rental';
        if (/apartment building/.test(lc)) return 'Apartment Building';
        if (/\bvilla\b/.test(lc)) return 'Villa';
        if (/homestay/.test(lc)) return 'Homestay';
        if (/tourist inn|^inn\b/.test(lc)) return 'Inn';
        if (/lodging|^lodge\b/.test(lc)) return 'Lodge';
        if (/campground|camping/.test(lc)) return 'Campground';
        if (/cottage/.test(lc)) return 'Cottage';
        if (/motel/.test(lc)) return 'Motel';
        const cm = lc.match(/^(.+?)\s+restaurant$/);
        if (cm) return cap(cm[1]) + ' Restaurant';
        if (/^restaurant$/.test(lc)) return 'Restaurant';
        if (/cocktail bar/.test(lc)) return 'Cocktail Bar';
        if (/sports bar/.test(lc)) return 'Sports Bar';
        if (/wine bar/.test(lc)) return 'Wine Bar';
        if (/brewery|brewpub/.test(lc)) return 'Brewery';
        if (/^pub\b/.test(lc)) return 'Pub';
        if (/night ?club/.test(lc)) return 'Nightclub';
        if (/^bar$/.test(lc)) return 'Bar';
        if (/^cafe$|^café$|coffee shop/.test(lc)) return 'Cafe';
        if (/bakery/.test(lc)) return 'Bakery';
        if (/ice cream|gelato/.test(lc)) return 'Ice Cream Shop';
        if (/bbq|barbecue/.test(lc)) return 'BBQ';
        if (/pizza/.test(lc)) return 'Pizzeria';
        if (/tour operator/.test(lc)) return 'Tour Operator';
        if (/travel agency/.test(lc)) return 'Travel Agency';
        if (/dive (shop|center|centre)|diving (center|centre|school)/.test(lc)) return 'Dive Shop';
        if (/boat (tour|rental)/.test(lc)) return 'Boat Tour';
        if (/motorcycle rental|scooter rental/.test(lc)) return 'Motorbike Rental';
        if (/massage/.test(lc)) return 'Massage Spa';
        if (/^spa$|day spa/.test(lc)) return 'Spa';
        if (/tattoo/.test(lc)) return 'Tattoo Studio';
        if (/souvenir/.test(lc)) return 'Souvenir Shop';
        if (/clothing store/.test(lc)) return 'Clothing Store';
        if (/tourist attraction/.test(lc)) return 'Tourist Attraction';
        if (/scenic spot|view ?point/.test(lc)) return 'Scenic Spot';
        if (/waterfall|falls$/.test(lc)) return 'Waterfall';
        if (/beach\b/.test(lc)) return 'Beach';
        if (/nature (reserve|preserve)/.test(lc)) return 'Nature Park';
        if (/^gym\b|fitness center/.test(lc)) return 'Fitness Center';
        return cap(r);
      })(industry);

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
