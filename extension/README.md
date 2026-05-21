# Hotel Data Collector (Chrome MV3)

Enriches a Google-Maps-export CSV with **Website, Phone, Instagram, Facebook, WhatsApp**.

## Install
1. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, select this `extension/` folder.
2. Pin the extension. Click its icon to open the popup.

## Use
1. **Choose File** → pick `hotels.csv` (must have a `Google Maps Link` column; `Title` recommended).
   Missing columns (`Website`, `Phone`, `Instagram`, `WhatsApp`, optionally `Facebook`) are appended automatically.
2. Click **Start**. The extension will, for each row:
   - open the Maps link in a background tab → scrape Website + Phone → close tab,
   - if a real website exists, open it → scrape IG/FB/WhatsApp → close tab.
3. Progress + per-row log appears in the popup. Click **Stop** anytime; **Start** again resumes from where it left off.
4. Click **Export CSV** to download `hotels_enriched.csv`.

## Notes
- Existing non-empty values in the CSV are **never overwritten**.
- Google ad-redirect URLs (`google.com/aclk?...`) are detected as Maps' website field but skipped for site scraping (they don't resolve to the hotel's real site without a click).
- Throttled ~1s between rows. If Google starts showing a captcha, **Stop**, solve it in any open Maps tab, and **Start** again.
- All state lives in `chrome.storage.local`; **Clear** wipes it.
