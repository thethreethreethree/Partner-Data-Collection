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
    // Force a large size. URLs end in a size token like =w114-h86-k-no, =s86,
    // =w408-h272-k-no-pi... — replace it; if none present, append one.
    return /=[^/]*$/.test(url)
      ? url.replace(/=[^/]*$/, '=w2048-h1536-k-no')
      : url + '=w2048-h1536-k-no';
  }
  return url;
}

// Score a candidate photo URL: real Google place photos (lh3.../p/ or gps-cs-s)
// are full-res; generic profile/avatar URLs (=s44, a-/AC...) are tiny.
function imgScore(url) {
  if (!url) return -1;
  let s = 0;
  if (/googleusercontent\.com\/(p|gps-cs|gps-proxy)/.test(url)) s += 100;
  else if (/googleusercontent\.com|ggpht\.com/.test(url)) s += 40;
  const wm = url.match(/[=&]w(\d+)/); if (wm) s += Math.min(50, parseInt(wm[1], 10) / 40);
  if (/=s\d/.test(url) && !/=w/.test(url)) s -= 30; // square avatar token
  if (/\/a-?\//.test(url) || /=s(32|44|48|64|72|96)\b/.test(url)) s -= 60; // user avatars
  return s;
}

// Map Google's raw category strings to clean, consistent labels.
// Goals:
//   - 100% population (any non-empty raw string yields a usable Industry)
//   - PRESERVE cuisine specificity ("Italian restaurant" → "Italian Restaurant",
//     NOT collapsed to plain "Restaurant")
//   - Collapse redundant Google variants ("Resort hotel" → "Resort", "Bed and
//     breakfast" → "Bed & Breakfast")
//   - Title-case the output so the CSV reads consistently
function normalizeCategory(raw) {
  if (!raw) return '';
  const r = String(raw).trim().replace(/\s+/g, ' ');
  if (!r) return '';
  const lc = r.toLowerCase();
  const cap = (s) => s.split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');

  // ─── ACCOMMODATIONS ─────────────────────────────────────────────────────
  if (/backpack|youth hostel|^hostel\b/.test(lc)) return 'Hostel';
  if (/resort hotel|beach resort|all.?inclusive resort|^resort\b/.test(lc)) return 'Resort';
  if (/boutique hotel|business hotel|capsule hotel|^hotel\b|extended stay hotel/.test(lc)) return 'Hotel';
  if (/bed (?:and|&) breakfast|^b&b$|^b ?and ?b$/.test(lc)) return 'Bed & Breakfast';
  if (/guest ?house/.test(lc)) return 'Guesthouse';
  if (/pension/.test(lc)) return 'Pension House';
  if (/serviced apartment/.test(lc)) return 'Serviced Apartment';
  if (/holiday apartment|vacation (apartment|rental)|apartment rental|holiday home/.test(lc)) return 'Apartment Rental';
  if (/apartment building/.test(lc)) return 'Apartment Building';
  if (/villa rental|holiday villa/.test(lc)) return 'Villa Rental';
  if (/\bvilla\b/.test(lc)) return 'Villa';
  if (/homestay|home stay/.test(lc)) return 'Homestay';
  if (/tourist inn|country inn|^inn\b/.test(lc)) return 'Inn';
  if (/lodging|^lodge\b/.test(lc)) return 'Lodge';
  if (/campground|camping|camp site|tent camp/.test(lc)) return 'Campground';
  if (/cottage/.test(lc)) return 'Cottage';
  if (/cabin/.test(lc)) return 'Cabin';
  if (/motel/.test(lc)) return 'Motel';
  if (/glamping/.test(lc)) return 'Glamping Site';
  if (/^lodging$/.test(lc)) return 'Lodging';

  // ─── RESTAURANTS — preserve cuisine ─────────────────────────────────────
  // Pattern: "<cuisine> restaurant" → "<Cuisine> Restaurant"
  const cuisineMatch = lc.match(/^(.+?)\s+restaurant$/);
  if (cuisineMatch) return cap(cuisineMatch[1]) + ' Restaurant';
  if (/^restaurant$/.test(lc)) return 'Restaurant';
  if (/fast food/.test(lc)) return 'Fast Food';
  if (/buffet/.test(lc)) return 'Buffet';
  if (/takeout|takeaway/.test(lc)) return 'Takeout';
  if (/delivery service/.test(lc)) return 'Food Delivery';
  if (/carinderia|eatery/.test(lc)) return 'Eatery';
  if (/diner/.test(lc)) return 'Diner';
  if (/canteen/.test(lc)) return 'Canteen';
  if (/food court|food hall/.test(lc)) return 'Food Court';
  if (/bistro/.test(lc)) return 'Bistro';
  if (/steakhouse|steak house/.test(lc)) return 'Steakhouse';
  if (/seafood/.test(lc)) return 'Seafood Restaurant';
  if (/grill house|bar (?:and|&) grill|bar.*grill/.test(lc)) return 'Bar & Grill';
  if (/pizzeria|pizza place|pizza/.test(lc)) return 'Pizzeria';
  if (/sushi/.test(lc)) return 'Sushi Restaurant';
  if (/ramen/.test(lc)) return 'Ramen Restaurant';
  if (/noodle/.test(lc)) return 'Noodle House';
  if (/dim sum/.test(lc)) return 'Dim Sum Restaurant';
  if (/bbq|barbecue|barbeque/.test(lc)) return 'BBQ';

  // ─── BARS, CAFÉS, NIGHTLIFE ─────────────────────────────────────────────
  if (/cocktail bar|cocktail lounge/.test(lc)) return 'Cocktail Bar';
  if (/sports bar/.test(lc)) return 'Sports Bar';
  if (/wine bar/.test(lc)) return 'Wine Bar';
  if (/beer garden|brewpub|brewery|tap room/.test(lc)) return 'Brewery';
  if (/karaoke/.test(lc)) return 'Karaoke Bar';
  if (/^pub\b|gastropub/.test(lc)) return 'Pub';
  if (/night ?club|disco|dance club/.test(lc)) return 'Nightclub';
  if (/^bar$/.test(lc)) return 'Bar';
  if (/^cafe$|^café$|coffee shop|coffee house|espresso bar/.test(lc)) return 'Cafe';
  if (/tea house|tea shop|bubble tea/.test(lc)) return 'Tea House';
  if (/juice bar|smoothie/.test(lc)) return 'Juice Bar';
  if (/bakery|patisserie|cake shop/.test(lc)) return 'Bakery';
  if (/ice cream|gelato|frozen yogurt/.test(lc)) return 'Ice Cream Shop';
  if (/dessert/.test(lc)) return 'Dessert Shop';
  if (/snack bar|snack shop|street food/.test(lc)) return 'Snack Bar';

  // ─── EXPERIENCES — preserve activity specificity ────────────────────────
  if (/tour operator|tour agency|excursion/.test(lc)) return 'Tour Operator';
  if (/travel agency|travel agent/.test(lc)) return 'Travel Agency';
  if (/dive (shop|center|centre)|diving (center|centre|school)|scuba (instructor|diving|center)/.test(lc)) return 'Dive Shop';
  if (/snorkel/.test(lc)) return 'Snorkel Tour';
  if (/boat (tour|rental|charter)|yacht charter|sailing/.test(lc)) return 'Boat Tour';
  if (/kayak/.test(lc)) return 'Kayak Tour';
  if (/surf school|surf shop/.test(lc)) return 'Surf School';
  if (/yoga (studio|class)/.test(lc)) return 'Yoga Studio';
  if (/cooking class|culinary school/.test(lc)) return 'Cooking Class';
  if (/motorcycle rental|scooter rental|moped rental/.test(lc)) return 'Motorbike Rental';
  if (/car rental|vehicle rental/.test(lc)) return 'Car Rental';
  if (/bicycle rental|bike rental/.test(lc)) return 'Bike Rental';
  if (/massage (spa|therapist)|massage$|reflexology/.test(lc)) return 'Massage Spa';
  if (/^spa$|day spa|wellness/.test(lc)) return 'Spa';
  if (/tattoo (shop|studio|parlor)|tattoo and piercing|tattoo$/.test(lc)) return 'Tattoo Studio';
  if (/^barber\b|barber shop/.test(lc)) return 'Barber Shop';
  if (/hair salon|beauty salon|nail salon/.test(lc)) return 'Salon';
  if (/^gym\b|fitness center|fitness centre|crossfit/.test(lc)) return 'Fitness Center';
  if (/souvenir|gift shop/.test(lc)) return 'Souvenir Shop';
  if (/clothing store|boutique\b/.test(lc)) return 'Clothing Store';
  if (/camera (store|shop)/.test(lc)) return 'Camera Shop';
  if (/tourist attraction/.test(lc)) return 'Tourist Attraction';
  if (/scenic spot|view ?point|observation deck/.test(lc)) return 'Scenic Spot';
  if (/national park|nature (reserve|preserve|park)/.test(lc)) return 'Nature Park';
  if (/wildlife|sanctuary|zoo/.test(lc)) return 'Wildlife Park';
  if (/waterfall|falls$/.test(lc)) return 'Waterfall';
  if (/beach\b|cove|lagoon/.test(lc)) return 'Beach';
  if (/island$/.test(lc)) return 'Island';
  if (/museum/.test(lc)) return 'Museum';
  if (/historical (place|landmark|site)|monument/.test(lc)) return 'Historic Site';
  if (/temple|church|cathedral|mosque|shrine/.test(lc)) return 'Religious Site';
  if (/amusement park|theme park/.test(lc)) return 'Amusement Park';
  if (/water park/.test(lc)) return 'Water Park';
  if (/golf (course|club)/.test(lc)) return 'Golf Course';

  // ─── FALLBACK ───────────────────────────────────────────────────────────
  // Unknown raw — title-case it so the CSV looks consistent. We DO NOT
  // throw away the data; an unfamiliar but real Google category beats empty.
  return cap(r);
}

function scrape() {
  let website = '', phone = '', image = '', address = '', category = '';

  // Authoritative address from the place panel.
  const addrEl = document.querySelector('button[data-item-id="address"], [data-item-id="address"]');
  if (addrEl) {
    const lbl = addrEl.getAttribute('aria-label') || addrEl.textContent || '';
    address = lbl.replace(/^Address:\s*/i, '').trim();
  }

  // Category / industry — extracted in 3 strategies, in order of reliability.
  // Strategy 1: the explicit category button (most stable when present).
  const catEl = document.querySelector(
    'button[jsaction*="category"], button[jsaction*="pane.rating.category"]'
  );
  if (catEl) category = (catEl.textContent || '').trim();
  // Strategy 2: walk the title's container for the first non-rating, non-action
  // button. Maps' DOM layout puts the category as the 1st clickable text element
  // next to the heading, separate from the rating button — different elements
  // on accommodation pages (which is why the search-card parser misses them).
  if (!category) {
    const main = document.querySelector('[role="main"]');
    const h1 = main && main.querySelector('h1');
    if (h1) {
      let scope = h1.parentElement;
      outer: for (let i = 0; i < 5 && scope; i++) {
        for (const btn of scope.querySelectorAll('button, span[role="button"]')) {
          const text = (btn.textContent || '').trim();
          const aria = btn.getAttribute('aria-label') || '';
          if (!text || text.length > 60) continue;
          // Reject rating/review/price/action/navigation/hours buttons.
          if (/stars|reviews?|\(\d|^\d+\.\d|\d{2,}\)/i.test(text + ' ' + aria)) continue;
          if (/^(share|save|directions|menu|website|call|photos|street view|nearby|back)/i.test(aria + ' ' + text)) continue;
          if (/(closed|^open|opens|closes|^hours|24 hours)/i.test(text)) continue;
          if (/^[\$€£¥+\d\s·,]+$/.test(text)) continue;
          // Looks category-shaped: starts with a letter, contains only normal words.
          if (/^[A-Za-z][A-Za-z\s&\-'/]{1,50}$/.test(text)) {
            category = text;
            break outer;
          }
        }
        scope = scope.parentElement;
      }
    }
  }
  // Strategy 3: og:type meta as a final fallback (rarely meaningful but better
  // than empty for the rare DOM-changed page Google ships).
  if (!category) {
    const ogType = document.querySelector('meta[property="og:type"]');
    const t = ogType && ogType.getAttribute('content');
    if (t && t !== 'website') category = t;
  }
  // Normalize the raw string (see normalizeCategory below for the rules).
  category = normalizeCategory(category);


  const candidates = new Set();
  // DOM sources
  document.querySelectorAll(
    'button[jsaction*="heroHeaderImage"] img, button[aria-label^="Photo of"] img, ' +
    'img[src*="googleusercontent.com"], img[src*="ggpht.com"], ' +
    'div[role="img"][style*="background-image"], button[style*="background-image"], a[style*="background-image"]'
  ).forEach((el) => {
    if (el.tagName === 'IMG' && el.src) candidates.add(el.src);
    else {
      const bg = el.getAttribute('style') || '';
      const m = bg.match(/url\(["']?(https?:[^"')]+)/);
      if (m) candidates.add(m[1]);
    }
  });
  // The place page embeds many photo URLs in inline scripts — always present.
  const html = document.documentElement.innerHTML;
  const re = /https:\/\/(?:lh\d+\.googleusercontent\.com\/(?:p|gps-cs-s|gps-proxy)\/[A-Za-z0-9_\-]+|streetviewpixels[^"\\\s]+)[^"\\\s]*/g;
  let mm; let count = 0;
  while ((mm = re.exec(html)) && count < 50) { candidates.add(mm[0]); count++; }

  // Pick the highest-scoring candidate, then force high-res.
  let best = '', bestScore = -1;
  candidates.forEach((u) => { const sc = imgScore(u); if (sc > bestScore) { bestScore = sc; best = u; } });
  image = upgradeGoogleImg(best);

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
    // Source: aria-labels on amenity chips/buttons/icons only. This avoids
    // false positives from review snippets that mention "pool" or "breakfast"
    // in passing. Cap label length to skip long review aria-labels.
    const labels = [];
    main.querySelectorAll('[aria-label]').forEach((el) => {
      const lbl = el.getAttribute('aria-label');
      if (lbl && lbl.length > 0 && lbl.length <= 80) labels.push(lbl);
    });
    const text = labels.join(' · ');
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
  return { website, phone, image, amenities, address, category };
}

function isMapsCaptcha() {
  if (/\/sorry\//i.test(location.pathname)) return true;
  const t = (document.body && document.body.innerText) || '';
  return /unusual traffic|systems have detected unusual|verify (you are|that you're) not a robot|i'm not a robot/i.test(t);
}

chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg.type === 'SCRAPE_MAPS') {
    if (isMapsCaptcha()) { sendResponse({ captcha: true }); return true; }
    waitFor(() => {
      const d = scrape();
      const sidebarLoaded = !!document.querySelector('[role="main"] h1, [data-item-id]');
      return (d.website || d.phone || d.image || d.amenities || d.address || d.category || sidebarLoaded) ? d : null;
    }, 10000).then((d) => sendResponse(d || { website: '', phone: '', image: '', amenities: '', address: '', category: '' }));
    return true;
  }
});
