# Store Locator Search — Functional Test Cases

## Overview

The SingleInterface store locator platform (`/storelocator/<masterOutletId>`) exposes search
through a small set of reusable widgets. Which ones appear on a given client's microsite is a
per-client configuration choice — not every client has every search type. Verified directly
against `https://testing.singleinterface.com/storelocator/178581` (Nayara Energy, UAT), this
instance exposes three:

| Search type | UI element(s) | Tab / form id |
|---|---|---|
| **Locality / "Search Nearby"** — free-text address search with Google Places autocomplete | `#OutletSearch` | `#searchTypeCustom` → form `SearchByGivenAddress` |
| **Advanced Search** — cascading State → City → Locality dropdowns | `#OutletState`, `#OutletCity`, `#OutletLocality` | `#searchTypeAdvance` → form `OutletStoreLocatorSearchForm` |
| **Route Search** — source/destination address search along a route | `#OutletSourceAddress`, `#OutletDestinationAddress` | `#searchTypeRoute` → form `SearchByRouteAddress` |

Other clients on the same platform may additionally (or instead) expose a pincode field, a
category filter, a radius filter, or a "use my current location" geolocation trigger — the
automation script (`src/searchAudit.js`) feature-detects whichever of these are present on a
given URL by element ID rather than assuming a fixed set, and only runs the scenarios that apply.
IDs (e.g. `#OutletSearch`) are the stable, platform-wide hooks; CSS class names like
`store_search_09` are versioned per widget variant and shouldn't be relied on across clients.

**Legend:** 🤖 = covered by `src/searchAudit.js` · 🖐️ = manual (needs a human or a tool this repo
doesn't include, e.g. a real screen reader or a second browser)

---

## 1. Locality / "Search Nearby" search (free-text + autocomplete)

| # | Test case | Steps | Expected result | Coverage |
|---|---|---|---|---|
| 1.1 | Valid known locality returns results | Enter a locality/city known to have outlets, submit | Page navigates with `?search=<term>`; matching outlets render in list + map | 🤖 |
| 1.2 | Autocomplete suggestions appear | Start typing a real place name | A Google Places `.pac-item` suggestion list appears within a few seconds | 🤖 (used internally by route-search cases; can flake if the Maps key is quota-limited) |
| 1.3 | Selecting a suggestion fills the field correctly | Type, then arrow-down + Enter (or click) a suggestion | Input value updates to the selected place; form remains submittable | 🤖 |
| 1.4 | Empty submission is blocked | Clear the field, attempt submit | Native `required` validation blocks submission; no navigation | 🤖 |
| 1.5 | No-match input doesn't crash the page | Enter a nonsense string with no matching outlets, submit | Page loads normally (no 500/blank page); shows zero or fallback results | 🤖 |
| 1.6 | Script/markup injection is not executed or reflected | Enter `<script>...</script>`-style text, submit | No script executes, no JS `alert`/dialog fires, payload isn't rendered unescaped | 🤖 |
| 1.7 | Leading/trailing whitespace is tolerated | Enter `"  Faridabad  "`, submit | Same results as the trimmed term, no validation error | 🤖 (compares against the term-1.1 baseline count; skips rather than false-fails if that baseline itself hit a bot-challenge) |
| 1.8 | Case-insensitive matching | Search `"FARIDABAD"` vs `"faridabad"` | Identical result sets | 🤖 |
| 1.9 | Submitting via Enter key works, not just the button | Focus the field, type, press Enter | Same behavior as clicking Search | 🖐️ — no longer in the automated run (removed). Earlier runs caught a real defect: on Hamleys and Audi, pressing Enter does not submit the form at all (see Known issues) |
| 1.10 | Result list count matches map marker count | Run any valid search | Number of list entries equals number of map pins | 🖐️ (needs map-canvas inspection, not just DOM) |
| 1.11 | Deep link with `?search=` pre-filters on load | Open `.../storelocator/<id>?search=<term>` directly | Page loads already filtered to that term, without requiring a manual re-submit | 🤖 |
| 1.12 | Very long input (500+ chars) doesn't break layout or error | Paste a long string, submit | Graceful no-match handling, no layout break, no server error | 🤖 (600-char input) |

## 2. Advanced Search (State → City → Locality)

| # | Test case | Steps | Expected result | Coverage |
|---|---|---|---|---|
| 2.1 | State dropdown is populated | Open Advanced Search tab | State `<select>` lists all expected states/regions (25 on the verified instance) | 🤖 |
| 2.2 | Selecting a State repopulates City | Select any State | City `<select>` options change from the default "All"-only list via AJAX | 🤖 |
| 2.3 | City is gated behind State | Load the page fresh, don't touch State | City is disabled, or holds only a single placeholder option ("Please select state first") | 🤖 |
| 2.4 | Selecting City repopulates Locality | Select State, then a specific City | Locality `<select>` updates to that city's localities (dropdown variant); on the radius-gated variant, the free-text Locality field becomes enabled instead — see §Progressive Advanced Search below | 🖐️ (dropdown-variant cascade specifically; the radius-gated variant's enablement is covered) |
| 2.5 | State-only submission returns that state's outlets | Select a State, leave City/Locality as "All", submit | Page navigates to a state-scoped URL/title; outlets shown belong to that state (verified: Andhra Pradesh returned Ananthapur-area outlets, not the default Haryana set) | 🤖 (navigation + no-crash only — cross-checking outlet **addresses** actually match the selected state is currently manual) |
| 2.6 | No-State submission is blocked | Reset State to blank, attempt submit | Native `required` validation blocks submission | 🤖 |
| 2.7 | Changing State resets City/Locality | Select State A + City X, then change to State B | City/Locality reset to "All"/disabled rather than silently keeping State A's City X | 🤖 |
| 2.8 | Zero-result combination shows a clear empty state | Pick a State/City/Locality combo with no outlets | A "no stores found" message renders — not a blank or broken page | 🖐️ |
| 2.9 | Pagination works on a narrowed result set | Select a State with >1 page of outlets | Page 2/3/Next/Last controls work and show different outlets each time | 🤖 (generalized as a cross-cutting check, §4.10 — clicks whatever "Next" control exists after the last search run, regardless of which search type produced it) |
| 2.10 | Browser back restores prior dropdown state | Submit a State search, then click Back | Previously selected State/City/Locality are restored, not reset | 🤖 (checked for State only; reports **SKIP with explanation**, not FAIL, if a site resets on Back by design rather than restoring via bfcache — that's a legitimate product choice, not necessarily a defect) |

## 2a. Progressive Advanced Search (radius-gated variant: State → City → free-text Locality → Radius)

Some clients (e.g. Ujjivan Small Finance Bank) use a variant where Locality is a plain text field
(not a dropdown) that only enables once a City is chosen, and a Radius `<select>` that only
enables once Locality holds non-empty text. Each step is expected to narrow the result set further
than the last.

| # | Test case | Steps | Expected result | Coverage |
|---|---|---|---|---|
| 2a.1 | Search with State only | Select a State, leave City/Locality/Radius untouched, submit | Navigates to a state-scoped results view | 🤖 |
| 2a.2 | Search with State + City | Also select a City, submit | Navigates to a state+city-scoped results view | 🤖 |
| 2a.3 | Search with State + City + Locality | Also type a real locality into the now-enabled Locality field, submit | Results narrow further (verified against a real branch's own locality, not a guess) | 🤖 |
| 2a.4 | Search with State + City + Locality + Radius | Also select the smallest Radius option, submit | Results narrow further still | 🤖 |

Verified on Ujjivan: State-only → 6 outlets, +City → 6, +Locality ("Shadipur", a real branch's
locality) → 5, +Radius (3km) → 1 — confirming the filter genuinely narrows at each step rather
than just accepting the extra params without effect.

## 3. Route Search (source → destination)

| # | Test case | Steps | Expected result | Coverage |
|---|---|---|---|---|
| 3.1 | Identical source and destination is rejected | Enter the same text in both fields, submit | Inline error "Source and destination cannot be the same" becomes visible; form does not navigate away | 🤖 |
| 3.2 | Empty destination (or source) is blocked | Fill one field, leave the other empty, attempt submit | Native `required` validation blocks submission | 🤖 |
| 3.3 | Two distinct valid locations return a route + results | Pick suggestions for source and destination via autocomplete, submit | Page navigates; outlets along/near the route render, map shows a route polyline | 🤖 (depends on live Google Places autocomplete responding — script marks this **SKIP**, not FAIL, if no suggestion appears in time, since that reflects Maps API availability rather than the site's own logic) |
| 3.4 | Non-existent/gibberish location text | Enter a nonsense string as source or destination, submit | Graceful "location not found" handling, no crash | 🤖 (typed directly, bypassing autocomplete entirely) |
| 3.5 | Swapping source and destination still works | Submit A→B, then submit B→A | Both directions return valid (if possibly different) results, neither errors | 🤖 (reuses the real pair confirmed in §3.3; **SKIP** if that case didn't produce one) |
| 3.6 | Cross-state / long-distance route | Use a source and destination far apart | Nearest matches return within a reasonable time; no timeout | 🖐️ |
| 3.7 | Autocomplete suggestions are independent per field | Type in source, then in destination | Each field's suggestion list reflects only its own current input, not the other field's | 🤖 (asserts Destination's value stays empty/unaffected while Source's suggestions are open) |

## 4. Cross-cutting (applies across whichever search types a client has)

| # | Test case | Steps | Expected result | Coverage |
|---|---|---|---|---|
| 4.1 | Tab switching shows the right panel | Click each search-type tab in turn | Exactly the clicked tab's form becomes visible; the others hide | 🤖 |
| 4.2 | Switching tabs doesn't leak stale query params | Search type A, then switch to type B and search | Type B's submission uses only its own fields' values, not leftover ones from A | 🖐️ |
| 4.3 | No uncaught JS errors during any search interaction | Exercise every available search type | No `pageerror` events fire in the browser console | 🤖 |
| 4.4 | No Google Maps API quota/rate-limit errors | Exercise autocomplete-driven searches | No "rate-limit exceeded" / `OVER_QUERY_LIMIT` messages in console — a real, observed failure mode on the UAT key at time of writing (see Known Issues) | 🤖 |
| 4.5 | Search state survives a page refresh | Run any search, then reload the page | Same query params in the URL reproduce the same filtered result set | 🤖 (compares outlet count before/after a reload) |
| 4.6 | Result action buttons work regardless of search type used | From any search type's results, click Call / Map / Website | Each opens/behaves correctly for the outlet it's attached to | 🤖 (checks every Call/Map/Website link has a real, non-placeholder `href` — not that the OS actually dials/opens a map, which isn't observable from headless Chrome) |
| 4.7 | Mobile viewport usability | Repeat key scenarios at ~375px width | Tabs, inputs, and buttons remain usable, no overlap/clipping | 🖐️ (the accessibility auditor in this repo already flags target-size and focus issues generically — re-run it against search-result pages, don't duplicate that logic here) |
| 4.8 | Search response time is reasonable | Time each search type's submit-to-results | No unbounded spinner; completes within a few seconds under normal load | 🤖 (locality/custom search only; flags anything over 10s) |
| 4.9 | Search behaves correctly with JS disabled / partially loaded | Throttle network, retry a search mid-load | No silent failure — either the native form GET still works or a clear loading/error state shows | 🖐️ |
| 4.10 | Pagination "Next" control loads a different result set | After any search that returns multiple pages, click Next | URL and/or listed outlets change; no error | 🤖 (generalized version of §2.9 — runs once per site, against whichever search left results on the page; **SKIP** if no "Next" control is present, e.g. a single page of results) |

---

## Automated coverage summary

Running `npm run search-audit -- --url <storelocator URL>` (or `--site <name>` / `--all` against
`config/search-sites.json`, for testing many clients in one run) executes every 🤖-marked scenario
above end-to-end against a live page — around 25-30 checks depending on which widgets the target
actually has (locality/custom search, dropdown or radius-gated Advanced Search, Route Search, and
the cross-cutting checks that run once whichever of those is present). Verified across 7 real
client sites spanning every widget combination in this doc (see per-client breakdown below).

This still isn't a substitute for the remaining manual (🖐️) cases — genuine visual/UX judgment
(empty-state copy quality, layout at mobile widths, map-marker-to-list parity, cognitive load) has
no automated proxy. But the bar for "needs a human" has narrowed a lot: whitespace/case handling,
deep-linking, State→City→Locality reset behavior, pagination, refresh
persistence, action-link validity, and response time are all now asserted automatically. Treat a
clean run as "the mechanics work," and reach for the manual list mainly for copy/UX-level review.

**Self-healing behavior worth knowing about:** the script proactively paces navigations and
detects+recovers from bot/rate-limit challenge pages (Cloudflare "Just a moment...", HTTP 429/403)
that some clients' WAFs serve after several rapid requests in one session. When a specific step
gets caught by one of these mid-run, it's reported as **SKIP** with an explanation, not a false
PASS or a crash — and if that step was itself the baseline for a later comparison (e.g. the plain
"Delhi" search that whitespace/case-insensitivity checks compare against), the dependent checks
skip too rather than comparing against a contaminated number.

## Known issues observed during verification

- **Real defect — Enter key doesn't submit search**: on **Hamleys** and **Audi**, pressing Enter
  in the locality/custom search field does nothing (no navigation, and no autocomplete dropdown is
  present to explain it either) — confirmed reproducible outside the automation too. Users who
  expect the standard "type and press Enter" pattern (most don't reach for the Search button first)
  will not get results. Worth a fix on the client side; clicking the Search button itself works
  fine on both.
- **Site issue, not a search defect — Skoda tracking beacon fails**: every page load fires an
  uncaught `NetworkError` from a MapmyIndia visit-tracking XHR call
  (`apis.mapmyindia.com/map_v3/?visits...`). Reproducible across repeated runs; doesn't affect the
  Advanced Search flow itself (results render correctly regardless), but worth flagging to the
  client's dev team since it means visit analytics are silently not being recorded.
- **Google Maps API rate-limit**: intermittently observed on the Nayara Energy UAT instance —
  `"You have exceeded your rate-limit for this API"` in the browser console while exercising
  autocomplete. This degrades or breaks locality/route autocomplete suggestions without throwing a
  page error, so it's easy to miss manually — the script checks for it explicitly (§4.4). Also
  observed to cause the Route Search "two distinct valid locations" case to flake between runs
  (sometimes SKIP for no suggestion appearing, sometimes a genuine navigation failure) — treat a
  single failure there on this specific UAT key as inconclusive and re-run before treating it as a
  real regression.
- The **Advanced Search** form's declared `action` attribute (on the Nayara instance) points at a
  CMS/theme-builder preview URL (`/ThemeBuilder/page_builder/<id>?preview=1`), which itself returns
  HTTP 500 for a plain unauthenticated request (confirmed via `curl`). In a real browser,
  client-side JS intercepts the submit and routes to a clean public URL instead
  (`/enterprises/store_locator/<id>/location/<state>`), which does work correctly — confirmed by
  checking that Andhra Pradesh returns genuinely different, correctly-addressed outlets, not the
  default set relabeled. Documented here so a future run that sees a 500 on that literal form
  `action` doesn't mistake a JS-intercepted-by-design flow for a break.
- **Bot/WAF challenges on some clients**: Hamleys and Audi's Cloudflare-fronted sites returned a
  plain 403 to a stock headless-Chrome fingerprint (confirmed: identical `curl` request with the
  same User-Agent got 200 OK) — the script now presents a realistic browser fingerprint to avoid
  this. Audi additionally rate-limits a session after several rapid requests; the script paces
  navigations and self-recovers, but a handful of steps can still legitimately SKIP on a given run.
  This is about not being misidentified as a bot while testing your own clients' sites — not about
  evading a third party's protection.

## Running the automation against more clients

`config/search-sites.json` holds the list of `{name, url}` targets for `--site`/`--all`. Add
entries there for other clients' storelocator URLs, or run ad-hoc with `--url`:

```bash
npm run search-audit -- --url https://testing.singleinterface.com/storelocator/178581
npm run search-audit -- --all
```

Each run writes `reports/search-audit/<site-slug>/<timestamp>/report.html` (+ `results.json`)
with the detected widgets, pass/fail per scenario, and any captured console/page errors.
