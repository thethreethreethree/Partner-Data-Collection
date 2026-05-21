# Partner Collection (Chrome MV3)

Two-stage pipeline in one extension:

1. **Scrape Google Maps search results** (Title, Rating, Reviews, Phone, Industry, Address, Website, Lat/Lng, Maps link, plus IG/FB if exposed) — only rows ≥ 3.5★ are kept.
2. **Auto-enrich** each kept row by visiting its Maps place page (fills Website + Phone) and its website (fills Instagram, Facebook, WhatsApp).
3. **Download CSV** with all 13 columns ready.

## Install
1. Copy your `map.png` icon into this folder (the existing EBP icon — `combined-extension/map.png`).
2. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select `combined-extension/`.
3. Pin the extension.

## Use
1. Open Google Maps and run a search like `hotels in El Nido` so the URL is `https://www.google.com/maps/search/...`.
2. Scroll the results panel to load as many entries as you want.
3. Click the extension icon → **Scrape Google Maps**.
   - Results render in the table. Rows < 3.5★ are filtered out (see Scrape Summary).
   - If **auto-enrich after scrape** is checked (default), enrichment starts immediately.
4. Watch the enrichment progress + log. Click **Stop** any time; clicking **Enrich Data** later resumes from the last row.
5. Click **Download CSV** (optional custom filename) for the final file.

## Columns produced
`Title, Rating, Reviews, Phone, WhatsApp, Instagram, Facebook, Industry, Address, Website, Latitude, Longitude, Google Maps Link`

## Notes
- Existing non-empty values are **never overwritten** — the scraper's guess is preserved if enrichment finds something different (and vice versa for blanks).
- Google ad-redirect URLs (`google.com/aclk?...`) are detected as the Maps "website" but skipped for site-scraping (they don't resolve to a real site without a click).
- WhatsApp is built from the phone number (`wa.me/<digits>`) and overridden if the website exposes an explicit `wa.me/`, `api.whatsapp.com/send`, or `chat.whatsapp.com/` link.
- Throttled ~1s/row. If Google throws a captcha, **Stop**, solve it in any open Maps tab, then click **Enrich Data** to resume.
- State (rows + progress) lives in `chrome.storage.local` and survives closing the popup.
