# Store Locator Search Functionality Audit

Local CLI that functionally tests the **search** widgets on a SingleInterface storelocator page
(`/storelocator/<id>`, or a client's own custom domain in front of it). Different clients expose
different combinations of search type — free-text locality search, cascading State/City/Locality
dropdowns, a radius-gated progressive variant, route-based (source → destination) search — so the
tool feature-detects what's actually present on a given URL by element ID and only runs the
scenarios that apply. Runs entirely on your machine with headless Chrome via Puppeteer; no
external service, no per-run token cost.

## Setup (one-time)

```bash
npm install
```

## Web UI — import a sheet of URLs, run, export results

```bash
npm run server
```

Open **http://localhost:4173**. From there you can:

1. **Import** — upload a `.csv` or `.xlsx` sheet of client URLs (any header naming that contains
   "name"/"client" and "url"/"link" works — e.g. the columns "Clients"/"URLs" — or no header row
   at all, treating column A as name and column B as URL), click **Load saved sites** to pull in
   `config/search-sites.json`, and/or add rows by hand. Edit or remove any row before running.
2. **Run** — click **Run Audit**. Each site's detected widgets and scenario results stream in
   live as they complete (no waiting for the whole batch before seeing anything).
3. **Export** — once the run finishes, **Export Results as CSV** downloads one row per scenario
   check across every site in that run (Client Name, Client URL, Detected Widgets, Scenario,
   Status, Detail) — ready to open in Excel/Sheets.

The server reuses the exact same audit logic as the CLI below (`src/auditRunner.js`), so results
are identical either way — the web UI is just a friendlier way to feed it many URLs at once and
get a spreadsheet back out.

## CLI usage

Add sites to `config/search-sites.json`:

```json
{
  "sites": [
    { "name": "nayara-energy-uat", "url": "https://testing.singleinterface.com/storelocator/178581" },
    { "name": "ujjivan-sfb", "url": "https://nearme.ujjivansfb.bank.in/" }
  ]
}
```

Then run:

```bash
# One site by name
npm run search-audit -- --site ujjivan-sfb

# Multiple named sites
npm run search-audit -- --site ujjivan-sfb --site nayara-energy-uat

# Every site in config/search-sites.json
npm run search-audit -- --all

# Ad-hoc URL not in config
npm run search-audit -- --url https://example.com/storelocator/12345 --name example
```

## What it tests

Feature-detected per site, then whichever of these apply are run:

- **Locality / "Search Nearby" (custom search)** — valid-term submission, empty-field blocking,
  no-crash on nonsense/very-long input, script-injection safety, whitespace/case tolerance,
  Enter-key submission, deep-linking (`?search=`)
- **Advanced Search (State → City → Locality dropdowns)** — dropdown population, AJAX cascading,
  City gated behind State, changing State resets City, no-State-selected blocking, state-only
  submission, browser-Back state restoration
- **Progressive Advanced Search (radius-gated variant)** — the State → City → free-text Locality →
  Radius variant some clients use, tested at each of the four progressive combinations
- **Route Search (source → destination)** — identical-address rejection, empty-field blocking,
  two distinct real locations via live autocomplete, non-existent locations, swapping
  source/destination, per-field autocomplete independence
- **Cross-cutting** (once per site, against whichever search left results on the page) — tab
  switching, no uncaught JS errors, no Google Maps API quota/rate-limit errors, refresh
  persistence, result action-link (Call/Map/Website) validity, pagination, response time

Full test-case matrix, including the handful of cases still manual (visual/UX judgment — mobile
layout, empty-state copy quality, map-marker-to-list parity):
[docs/storelocator-search-test-cases.md](docs/storelocator-search-test-cases.md).

## Output

- `reports/search-audit/<site-slug>/<timestamp>/report.html` — per-site report: detected widgets,
  pass/fail/skip per scenario, and any captured console/page errors.
- `reports/search-audit/<site-slug>/<timestamp>/results.json` — the same, as raw data.

## Notes

- **Self-healing against bot/rate-limit protection**: the script presents a realistic browser
  fingerprint (not a stock headless-Chrome one) and paces navigations, since some clients'
  Cloudflare-style WAFs otherwise misidentify a headless session as a bot (a plain `curl` with the
  same User-Agent gets 200 OK where headless Chrome got a 403) or rate-limit a session after
  several rapid requests. When a step still gets caught by one of these mid-run, it's reported as
  **SKIP** with an explanation rather than a false PASS or a crash — and any later check that would
  have compared against that step's result skips too, rather than comparing against a
  contaminated baseline.
- A clean run is a regression/smoke signal ("the core mechanics still work"), not a substitute for
  a human pass when a release specifically touches search UX or copy.
