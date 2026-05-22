// Runs on DuckDuckGo HTML results pages. Given SCRAPE_SEARCH, returns the
// first valid Instagram (and Facebook) profile URL found in the results.

function ddgDecode(href) {
  try {
    if (href && href.includes('uddg=')) {
      const u = new URL(href, location.href);
      const t = u.searchParams.get('uddg');
      if (t) return decodeURIComponent(t);
    }
  } catch {}
  return href;
}

function validIg(url) {
  const m = (url || '').match(/instagram\.com\/([^\/?#]+)/i);
  if (!m) return false;
  const bad = ['p','explore','reel','reels','accounts','about','directory','tv','stories','sharer'];
  return !bad.includes(m[1].toLowerCase());
}
function validFb(url) {
  const m = (url || '').match(/facebook\.com\/([^\/?#]+)/i);
  if (!m) return false;
  const bad = ['sharer','sharer.php','dialog','plugins','tr','login','help','policies'];
  return !bad.includes(m[1].toLowerCase());
}

function scrapeResults() {
  const urls = Array.from(document.querySelectorAll('a[href]')).map((a) => ddgDecode(a.href));
  let instagram = '', facebook = '';
  for (const u of urls) {
    if (!instagram && /instagram\.com\//i.test(u) && validIg(u)) {
      const m = u.match(/https?:\/\/(www\.)?instagram\.com\/[^\/?#]+/i);
      if (m) instagram = m[0];
    }
    if (!facebook && /facebook\.com\//i.test(u) && validFb(u)) {
      const m = u.match(/https?:\/\/(www\.|m\.|web\.)?facebook\.com\/[^\/?#]+/i);
      if (m) facebook = m[0];
    }
    if (instagram && facebook) break;
  }
  return { instagram, facebook };
}

chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg.type === 'SCRAPE_SEARCH') {
    // Results are server-rendered; small delay covers slow loads.
    setTimeout(() => sendResponse(scrapeResults()), 400);
    return true;
  }
});
