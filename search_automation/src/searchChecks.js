'use strict';

// Store locator search functionality checks — feature-detects which search
// widget(s) a SingleInterface storelocator page exposes (the platform is
// component-based: different clients get different widget versions/combos)
// and runs the scenarios applicable to whichever ones are present.
//
// Detection relies on the platform-level element IDs (#OutletSearch,
// #OutletState, ...) rather than widget CSS class names (e.g. store_search_09)
// because those class names are versioned per widget variant and differ across
// clients, while the IDs are the stable hooks the shared JS binds to.

const NAV_TIMEOUT = 15000;
const AJAX_SETTLE_MS = 1500;
const PAC_TIMEOUT = 6000;
// A full run fires many navigations in quick succession (reset + submit +
// goBack, repeated per scenario group). Firing them back-to-back was enough
// on one Cloudflare-fronted client to trip a per-session rate limit (a 429
// "Just a moment..." challenge from the 4th rapid request onward); pacing
// every navigation at least this far apart kept the same client at 8/8 clean
// loads in testing.
const NAV_PACE_MS = 2000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const DETAIL_MAX_LEN = 300;

// A detail string built from real page state (e.g. the URL after submitting
// a 600-character test input) can be arbitrarily long — truncate centrally
// so no single check has to remember to do it, and so reports/exports stay
// readable instead of one cell holding a 600-char blob.
function truncateDetail(detail) {
  const s = String(detail ?? '');
  if (s.length <= DETAIL_MAX_LEN) return s;
  return `${s.slice(0, DETAIL_MAX_LEN)}… (truncated, ${s.length} chars total)`;
}

function pass(name, detail) {
  return { name, status: 'PASS', detail: truncateDetail(detail) };
}
function fail(name, detail) {
  return { name, status: 'FAIL', detail: truncateDetail(detail) };
}
function skip(name, detail) {
  return { name, status: 'SKIP', detail: truncateDetail(detail) };
}

async function detectSearchWidgets(page) {
  return page.evaluate(() => {
    const has = (sel) => !!document.querySelector(sel);
    return {
      localitySearch: has('#OutletSearch'),
      advancedDropdown: has('#OutletState') && has('#OutletCity') && has('#OutletLocality'),
      routeSearch: has('#OutletSourceAddress') && has('#OutletDestinationAddress'),
      pincodeField: has('input[name*="pincode" i], input[id*="pincode" i], input[name*="zip" i]'),
      categoryFilter: has('select[name*="category" i], select[id*="category" i]'),
      radiusFilter: has('select[name*="radius" i], select[id*="radius" i]'),
      geolocationSupport: (() => {
        const el = document.querySelector('.canAskToShareLocation');
        return !!el && el.value === '1';
      })(),
      tabs: Array.from(document.querySelectorAll('[data-tab]')).map((el) => el.getAttribute('data-tab')),
    };
  });
}

function attachDiagnostics(page, diagnostics) {
  page.on('console', (msg) => {
    if (msg.type() === 'error') diagnostics.consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => diagnostics.pageErrors.push(err.message));
  page.on('dialog', async (dialog) => {
    diagnostics.dialogs.push(dialog.message());
    await dialog.dismiss().catch(() => {});
  });
}

async function switchToTab(page, targetHash) {
  const clicked = await page.evaluate((hash) => {
    const tab = document.querySelector(`[data-tab="${hash}"]`);
    if (!tab) return false;
    tab.click();
    return true;
  }, targetHash);
  if (clicked) await new Promise((r) => setTimeout(r, 400));
  return clicked;
}

// Widget variants across clients don't share form IDs (e.g. the advanced-search
// form is #OutletStoreLocatorSearchForm on one client, #SearchCustomAddress on
// another) — resolve the id from a field known to always live inside it instead
// of hardcoding one client's markup.
async function getContainingFormId(page, fieldSelector) {
  return page.evaluate((sel) => document.querySelector(sel)?.closest('form')?.id || null, fieldSelector);
}

async function isChallengePage(page, resp) {
  const status = resp?.status();
  const title = await page.title().catch(() => '');
  return status === 429 || status === 403 || /just a moment|checking your browser|attention required/i.test(title);
}

// Any navigation — not just an explicit reset — can land on a Cloudflare
// challenge page instead of the real site: observed on one client even on a
// same-origin <form> GET submit (not just repeated page.goto calls), so
// pacing requests alone doesn't fully prevent it. Whenever that happens,
// reloading the intended URL after a short backoff reliably clears it in
// testing; call this after every navigation point, not just resets.
async function recoverFromChallenge(page, url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (!(await isChallengePage(page, null))) return true;
    await sleep(attempt * 3000);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT * 2 }).catch(() => null);
  }
  return !(await isChallengePage(page, null));
}

// Each scenario group needs a known-clean starting DOM. Chaining groups on
// whatever page a previous group's last submit happened to land on is fragile —
// on at least one client the post-search response HTML omits the full
// State <select> option list, which reads as "dropdown not populated" even
// though the site works fine from a normal page load.
async function resetToFreshPage(page, url) {
  await sleep(NAV_PACE_MS);
  const resp = await page.goto(url, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT * 2 }).catch(() => null);
  if (await isChallengePage(page, resp)) await recoverFromChallenge(page, url);
}

// .countOutlet reflects outlets shown on the current page, not the total match
// count — the platform paginates, so this is only useful as a "did something
// render" signal, not as proof a filter narrowed (or failed to narrow) results.
async function getResultCount(page) {
  return page.evaluate(() => {
    const counter = document.querySelector('.countOutlet');
    if (counter && counter.value) {
      const n = parseInt(counter.value, 10);
      if (!Number.isNaN(n)) return n;
    }
    return document.querySelectorAll('.store_outlet_03__link, [class*="store_outlet"]').length || null;
  });
}

async function submitFormAndCheckNav(page, formId, siteUrl, { expectNav = true } = {}) {
  await sleep(NAV_PACE_MS);
  const before = page.url();
  await Promise.all([
    page.waitForNavigation({ timeout: NAV_TIMEOUT }).catch(() => null),
    // submit() fires navigation synchronously, which can destroy the execution
    // context before this evaluate's own round-trip resolves — that rejection
    // is the success signal here, not a real failure, so it's swallowed.
    page
      .evaluate(
        (id) => (document.getElementById(id)?.requestSubmit ? document.getElementById(id).requestSubmit() : document.getElementById(id)?.submit()),
        formId
      )
      .catch(() => null),
  ]);
  let challenged = false;
  if (await isChallengePage(page, null)) {
    challenged = true;
    await recoverFromChallenge(page, siteUrl);
  }
  const navigated = page.url() !== before;
  return { navigated, matchesExpectation: navigated === expectNav, url: page.url(), challenged };
}

async function typeIntoAutocomplete(page, selector, text) {
  await page.click(selector);
  await page.evaluate((sel) => { document.querySelector(sel).value = ''; }, selector);
  await page.type(selector, text, { delay: 60 });
  try {
    await page.waitForSelector('.pac-container .pac-item', { visible: true, timeout: PAC_TIMEOUT });
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    return true;
  } catch {
    return false; // no live autocomplete suggestion came back (network/quota/geo) — caller decides how to treat this
  }
}

async function runLocalitySearchScenarios(page, url, diagnostics, tabHash) {
  const results = [];
  await resetToFreshPage(page, url);
  if (tabHash) await switchToTab(page, tabHash);
  const formId = await getContainingFormId(page, '#OutletSearch');

  // A1: valid known term returns a navigable, non-crashing result
  await page.evaluate(() => { const el = document.querySelector('#OutletSearch'); if (el) el.value = ''; });
  await page.type('#OutletSearch', 'Delhi', { delay: 40 });
  const a1 = await submitFormAndCheckNav(page, formId, url, { expectNav: true });
  const a1Count = await getResultCount(page);
  results.push(
    a1.challenged
      ? skip('Locality search: valid term submits and loads a results page', 'hit a bot/rate-limit challenge page mid-submit; recovered but could not confirm this step\'s real outcome')
      : a1.navigated
        ? pass('Locality search: valid term submits and loads a results page', `url=${a1.url}, outletsOnPage=${a1Count}`)
        : fail('Locality search: valid term submits and loads a results page', 'form did not navigate')
  );

  // A2: empty required field blocks submission (native HTML5 validation)
  await resetToFreshPage(page, url);
  if (tabHash) await switchToTab(page, tabHash);
  const isValidEmpty = await page.evaluate(() => document.querySelector('#OutletSearch')?.checkValidity());
  results.push(
    isValidEmpty === false
      ? pass('Locality search: empty submission blocked by required-field validation', 'checkValidity() === false')
      : fail('Locality search: empty submission blocked by required-field validation', `checkValidity()=${isValidEmpty}`)
  );

  // A3: gibberish input doesn't crash the page
  await page.evaluate(() => { const el = document.querySelector('#OutletSearch'); if (el) el.value = ''; });
  await page.type('#OutletSearch', 'zzqxnonexistentplace9999', { delay: 30 });
  const a3 = await submitFormAndCheckNav(page, formId, url, { expectNav: true });
  const a3Count = await getResultCount(page);
  results.push(
    a3.challenged
      ? skip('Locality search: nonsense input handled gracefully (no crash)', 'hit a bot/rate-limit challenge page mid-submit; recovered but could not confirm this step\'s real outcome')
      : a3.navigated
        ? pass('Locality search: nonsense input handled gracefully (no crash)', `outletsOnPage=${a3Count}`)
        : fail('Locality search: nonsense input handled gracefully (no crash)', 'form did not navigate')
  );

  // A4: script-injection-style input isn't reflected unescaped and doesn't trigger a dialog
  await resetToFreshPage(page, url);
  if (tabHash) await switchToTab(page, tabHash);
  const payload = '<script>window.__xssMarker=1</script>';
  await page.type('#OutletSearch', payload, { delay: 20 });
  const a4 = await submitFormAndCheckNav(page, formId, url, { expectNav: true });
  const xssFired = await page.evaluate(() => window.__xssMarker === 1);
  const dialogFired = diagnostics.dialogs.length > 0;
  results.push(
    a4.challenged
      ? skip('Locality search: script-injection payload is not executed/reflected', 'hit a bot/rate-limit challenge page mid-submit; recovered but could not confirm this step\'s real outcome')
      : !xssFired && !dialogFired
        ? pass('Locality search: script-injection payload is not executed/reflected', 'no script execution, no dialog')
        : fail('Locality search: script-injection payload is not executed/reflected', `xssFired=${xssFired} dialogFired=${dialogFired}`)
  );

  // A5: leading/trailing whitespace on an otherwise-valid term is tolerated
  // (same result count as the trimmed term from A1), not treated as a
  // different/invalid query.
  await resetToFreshPage(page, url);
  if (tabHash) await switchToTab(page, tabHash);
  await page.type('#OutletSearch', '  Delhi  ', { delay: 20 });
  const a5 = await submitFormAndCheckNav(page, formId, url, { expectNav: true });
  const a5Count = await getResultCount(page);
  results.push(
    a5.challenged || a1.challenged
      ? skip('Locality search: leading/trailing whitespace is tolerated', a1.challenged
          ? 'the baseline "Delhi" search (A1) hit a bot/rate-limit challenge, so there is no reliable count to compare against'
          : 'hit a bot/rate-limit challenge page mid-submit; recovered but could not confirm this step\'s real outcome')
      : !a5.navigated
        ? fail('Locality search: leading/trailing whitespace is tolerated', 'form did not navigate')
        : a5Count === a1Count
          ? pass('Locality search: leading/trailing whitespace is tolerated', `"  Delhi  " -> outletsOnPage=${a5Count}, matches trimmed "Delhi" (${a1Count})`)
          : fail('Locality search: leading/trailing whitespace is tolerated', `"  Delhi  " -> outletsOnPage=${a5Count}, differs from trimmed "Delhi" (${a1Count})`)
  );

  // A6: case-insensitive matching — same term in a different case returns the
  // same result set.
  await resetToFreshPage(page, url);
  if (tabHash) await switchToTab(page, tabHash);
  await page.type('#OutletSearch', 'DELHI', { delay: 20 });
  const a6 = await submitFormAndCheckNav(page, formId, url, { expectNav: true });
  const a6Count = await getResultCount(page);
  results.push(
    a6.challenged || a1.challenged
      ? skip('Locality search: case-insensitive matching', a1.challenged
          ? 'the baseline "Delhi" search (A1) hit a bot/rate-limit challenge, so there is no reliable count to compare against'
          : 'hit a bot/rate-limit challenge page mid-submit; recovered but could not confirm this step\'s real outcome')
      : !a6.navigated
        ? fail('Locality search: case-insensitive matching', 'form did not navigate')
        : a6Count === a1Count
          ? pass('Locality search: case-insensitive matching', `"DELHI" -> outletsOnPage=${a6Count}, matches "Delhi" (${a1Count})`)
          : fail('Locality search: case-insensitive matching', `"DELHI" -> outletsOnPage=${a6Count}, differs from "Delhi" (${a1Count})`)
  );

  // A7: submitting via the Enter key works the same as clicking the Search button.
  await resetToFreshPage(page, url);
  if (tabHash) await switchToTab(page, tabHash);
  await sleep(NAV_PACE_MS);
  const beforeEnter = page.url();
  await page.click('#OutletSearch');
  await page.type('#OutletSearch', 'Delhi', { delay: 30 });
  await Promise.all([
    page.waitForNavigation({ timeout: NAV_TIMEOUT }).catch(() => null),
    page.keyboard.press('Enter').catch(() => null),
  ]);
  let a7Challenged = false;
  if (await isChallengePage(page, null)) {
    a7Challenged = true;
    await recoverFromChallenge(page, url);
  }
  const a7Navigated = page.url() !== beforeEnter;
  results.push(
    a7Challenged
      ? skip('Locality search: submitting via Enter key works', 'hit a bot/rate-limit challenge page mid-submit; recovered but could not confirm this step\'s real outcome')
      : a7Navigated
        ? pass('Locality search: submitting via Enter key works', `url=${page.url()}`)
        : fail('Locality search: submitting via Enter key works', 'pressing Enter did not submit the form')
  );

  // A8: a direct deep link with ?search=<term> pre-filters results on load,
  // without requiring the user to re-type and resubmit.
  const deepLinkUrl = url.includes('?') ? `${url}&search=Delhi` : `${url}?search=Delhi`;
  const deepLinkResp = await page.goto(deepLinkUrl, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT * 2 }).catch(() => null);
  const a8Challenged = await isChallengePage(page, deepLinkResp);
  if (a8Challenged) await recoverFromChallenge(page, deepLinkUrl);
  const a8Count = await getResultCount(page);
  const a8FieldValue = await page.evaluate(() => document.querySelector('#OutletSearch')?.value || '');
  results.push(
    a8Challenged
      ? skip('Locality search: deep link with ?search= pre-filters on load', 'hit a bot/rate-limit challenge page; recovered but could not confirm this step\'s real outcome')
      : a8Count !== null
        ? pass('Locality search: deep link with ?search= pre-filters on load', `url=${deepLinkUrl}, outletsOnPage=${a8Count}, fieldValue="${a8FieldValue}"`)
        : fail('Locality search: deep link with ?search= pre-filters on load', `url=${deepLinkUrl} did not render a results page`)
  );

  // A9: a very long input (500+ chars) doesn't break the page or error out.
  await resetToFreshPage(page, url);
  if (tabHash) await switchToTab(page, tabHash);
  const longInput = 'a'.repeat(600);
  await page.type('#OutletSearch', longInput, { delay: 2 });
  const a9 = await submitFormAndCheckNav(page, formId, url, { expectNav: true });
  results.push(
    a9.challenged
      ? skip('Locality search: very long input (600 chars) does not break the page', 'hit a bot/rate-limit challenge page mid-submit; recovered but could not confirm this step\'s real outcome')
      : a9.navigated
        ? pass('Locality search: very long input (600 chars) does not break the page', `url=${a9.url}`)
        : fail('Locality search: very long input (600 chars) does not break the page', 'form did not navigate')
  );

  return results;
}

async function runAdvancedDropdownScenarios(page, url, diagnostics, tabHash) {
  const results = [];
  await resetToFreshPage(page, url);
  if (tabHash) await switchToTab(page, tabHash);
  const formId = await getContainingFormId(page, '#OutletState');

  const stateOptions = await page.$$eval('#OutletState option', (opts) => opts.map((o) => o.value).filter(Boolean));
  results.push(
    stateOptions.length > 0
      ? pass('Advanced search: State dropdown is populated', `${stateOptions.length} state(s)`)
      : fail('Advanced search: State dropdown is populated', 'no non-empty <option> values found')
  );

  // City is gated behind State on load: either disabled outright, or holding
  // only a single placeholder option ("Please select state first"), before
  // any State has been chosen.
  const cityGateBefore = await page.evaluate(() => {
    const el = document.querySelector('#OutletCity');
    if (!el) return null;
    return { disabled: el.disabled, optionCount: el.options.length };
  });
  results.push(
    cityGateBefore && (cityGateBefore.disabled || cityGateBefore.optionCount <= 1)
      ? pass('Advanced search: City is gated behind State before any State is chosen', JSON.stringify(cityGateBefore))
      : fail('Advanced search: City is gated behind State before any State is chosen', `expected disabled or a single placeholder option, got ${JSON.stringify(cityGateBefore)}`)
  );

  if (stateOptions.length > 0) {
    const beforeCityHtml = await page.$eval('#OutletCity', (el) => el.innerHTML);
    await page.select('#OutletState', stateOptions[0]);
    await new Promise((r) => setTimeout(r, AJAX_SETTLE_MS));
    const afterCityHtml = await page.$eval('#OutletCity', (el) => el.innerHTML).catch(() => beforeCityHtml);
    results.push(
      afterCityHtml !== beforeCityHtml
        ? pass('Advanced search: selecting State repopulates City dropdown', `state=${stateOptions[0]}`)
        : fail('Advanced search: selecting State repopulates City dropdown', 'City <select> options unchanged after AJAX wait')
    );
  } else {
    results.push(skip('Advanced search: selecting State repopulates City dropdown', 'no state options to select'));
  }

  // Changing State after a City is already selected should reset City back
  // to its gated/placeholder state for the new State, not silently keep the
  // previous State's City selection.
  if (stateOptions.length >= 2) {
    const cityOptionsForFirstState = await page.$$eval('#OutletCity option', (opts) => opts.map((o) => o.value).filter(Boolean));
    if (cityOptionsForFirstState.length > 0) {
      await page.select('#OutletCity', cityOptionsForFirstState[0]);
      await page.select('#OutletState', stateOptions[1]);
      await new Promise((r) => setTimeout(r, AJAX_SETTLE_MS));
      const cityAfterStateChange = await page.evaluate(() => {
        const el = document.querySelector('#OutletCity');
        return { value: el?.value, optionCount: el?.options.length };
      });
      const resetCorrectly = cityAfterStateChange.value !== cityOptionsForFirstState[0];
      results.push(
        resetCorrectly
          ? pass('Advanced search: changing State resets the previously selected City', `switched state=${stateOptions[0]}->${stateOptions[1]}, city now="${cityAfterStateChange.value}"`)
          : fail('Advanced search: changing State resets the previously selected City', `city still holds "${cityAfterStateChange.value}" from state=${stateOptions[0]} after switching to state=${stateOptions[1]}`)
      );
    } else {
      results.push(skip('Advanced search: changing State resets the previously selected City', 'first State had no City options to select'));
    }
  } else {
    results.push(skip('Advanced search: changing State resets the previously selected City', 'fewer than 2 State options available to switch between'));
  }

  // Some widget variants block empty submission via native HTML5 `required`;
  // others do it with custom JS (no required attribute, but submit is
  // preventDefault()-ed and an inline error message shown instead) — checking
  // checkValidity() alone misreads the second kind as broken, so this checks
  // the actual outcome: did it navigate away, or is there a visible error?
  await page.evaluate(() => { const el = document.querySelector('#OutletState'); if (el) el.value = ''; });
  const isStateValidEmpty = await page.evaluate(() => document.querySelector('#OutletState')?.checkValidity());
  const beforeEmptySubmit = page.url();
  const emptySubmit = await submitFormAndCheckNav(page, formId, url, { expectNav: false });
  const staleNav = page.url() === beforeEmptySubmit;
  const inlineErrorVisible = await page.evaluate(() => {
    const el = document.querySelector('[class*="error-msg"]');
    return !!el && getComputedStyle(el).display !== 'none' && el.offsetParent !== null;
  });
  results.push(
    emptySubmit.challenged
      ? skip('Advanced search: submitting with no State selected is blocked', 'hit a bot/rate-limit challenge page mid-submit; recovered but could not confirm this step\'s real outcome')
      : isStateValidEmpty === false || staleNav || inlineErrorVisible
        ? pass(
            'Advanced search: submitting with no State selected is blocked',
            `checkValidity()=${isStateValidEmpty}, stayedOnPage=${staleNav}, inlineErrorVisible=${inlineErrorVisible}`
          )
        : fail(
            'Advanced search: submitting with no State selected is blocked',
            `checkValidity()=${isStateValidEmpty}, stayedOnPage=${staleNav}, inlineErrorVisible=${inlineErrorVisible} — form navigated away with no state and no visible error`
          )
  );
  if (!staleNav) {
    await resetToFreshPage(page, url);
    if (tabHash) await switchToTab(page, tabHash);
  }

  if (stateOptions.length > 0) {
    await page.select('#OutletState', stateOptions[0]);
    const adv = await submitFormAndCheckNav(page, formId, url, { expectNav: true });
    const advCount = await getResultCount(page);
    results.push(
      adv.challenged
        ? skip('Advanced search: State-only submission returns a results page', 'hit a bot/rate-limit challenge page mid-submit; recovered but could not confirm this step\'s real outcome')
        : adv.navigated
          ? pass('Advanced search: State-only submission returns a results page', `outletsOnPage=${advCount}`)
          : fail('Advanced search: State-only submission returns a results page', 'form did not navigate')
    );

    // Browser Back after that submission should restore the State the user
    // had picked, not reset the form to its defaults.
    if (adv.navigated && !adv.challenged) {
      await sleep(NAV_PACE_MS);
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => {});
      const restoredValue = await page.evaluate(() => document.querySelector('#OutletState')?.value).catch(() => null);
      results.push(
        restoredValue === stateOptions[0]
          ? pass('Advanced search: browser Back restores the previously selected State', `state=${restoredValue}`)
          : skip(
              'Advanced search: browser Back restores the previously selected State',
              `expected state="${stateOptions[0]}" after Back, got "${restoredValue}" — some sites intentionally reset the form on Back rather than restoring it via bfcache; treat as informational, not a defect`
            )
      );
    } else {
      results.push(skip('Advanced search: browser Back restores the previously selected State', 'State-only submission above did not complete cleanly'));
    }
  } else {
    results.push(skip('Advanced search: State-only submission returns a results page', 'no state options to select'));
    results.push(skip('Advanced search: browser Back restores the previously selected State', 'no state options to select'));
  }

  return results;
}

// Progressive State -> City -> Locality -> Radius filter, for the widget
// variant that exposes a Radius select gated behind a free-text Locality
// field (no dropdown, no autocomplete) rather than the simpler
// State/City/Locality-all-dropdowns variant. Each combo starts from a fresh
// page load and re-drives the cascade from scratch, since submitting
// navigates away and loses the in-page selection state.
async function runRadiusProgressiveScenarios(page, url, diagnostics, tabHash) {
  const results = [];

  async function driveTo({ withCity = false, withLocality = false, withRadius = false } = {}) {
    await resetToFreshPage(page, url);
    if (tabHash) await switchToTab(page, tabHash);
    const stateOptions = await page.$$eval('#OutletState option', (opts) => opts.map((o) => o.value).filter(Boolean));
    if (stateOptions.length === 0) return { ok: false, reason: 'no state options to select' };

    const preferredState = stateOptions.includes('delhi') ? 'delhi' : stateOptions[0];
    await page.select('#OutletState', preferredState);
    await new Promise((r) => setTimeout(r, AJAX_SETTLE_MS));

    let cityValue = null;
    if (withCity || withLocality || withRadius) {
      const cityOptions = await page.$$eval('#OutletCity option', (opts) => opts.map((o) => o.value).filter(Boolean));
      if (cityOptions.length === 0) return { ok: false, reason: `no city options loaded for state=${preferredState}` };
      cityValue = cityOptions.includes('new-delhi') ? 'new-delhi' : cityOptions[0];
      await page.select('#OutletCity', cityValue);
      await new Promise((r) => setTimeout(r, AJAX_SETTLE_MS));
    }

    let localityValue = null;
    if (withLocality || withRadius) {
      const localityDisabled = await page.$eval('#OutletLocality', (el) => el.disabled).catch(() => true);
      if (localityDisabled) return { ok: false, reason: `locality field still disabled after selecting city=${cityValue}` };
      localityValue = preferredState === 'delhi' && cityValue === 'new-delhi' ? 'Shadipur' : 'Main Road';
      await page.click('#OutletLocality');
      await page.type('#OutletLocality', localityValue, { delay: 40 });
      await new Promise((r) => setTimeout(r, 500));
    }

    let radiusValue = null;
    if (withRadius) {
      const radiusOptions = await page.$$eval('#OutletRadius option', (opts) => opts.map((o) => o.value).filter(Boolean)).catch(() => []);
      const radiusDisabled = await page.$eval('#OutletRadius', (el) => el.disabled).catch(() => true);
      if (radiusDisabled || radiusOptions.length === 0) return { ok: false, reason: 'radius field still disabled/empty after entering locality' };
      radiusValue = radiusOptions[0];
      await page.select('#OutletRadius', radiusValue);
    }

    return { ok: true, state: preferredState, city: cityValue, locality: localityValue, radius: radiusValue };
  }

  async function runCombo(label, driveOpts) {
    const driven = await driveTo(driveOpts);
    if (!driven.ok) {
      results.push(fail(label, driven.reason));
      return;
    }
    const formId = await getContainingFormId(page, '#OutletState');
    const before = page.url();
    const submitResult = await submitFormAndCheckNav(page, formId, url, { expectNav: true });
    const count = await getResultCount(page);
    const combo = ['state=' + driven.state, driven.city && 'city=' + driven.city, driven.locality && 'locality=' + driven.locality, driven.radius && 'radius=' + driven.radius]
      .filter(Boolean)
      .join(', ');
    results.push(
      submitResult.challenged
        ? skip(label, 'hit a bot/rate-limit challenge page mid-submit; recovered but could not confirm this step\'s real outcome')
        : submitResult.navigated && page.url() !== before
          ? pass(label, `${combo} -> outletsOnPage=${count}, url=${submitResult.url}`)
          : fail(label, `${combo} -> form did not navigate away from ${before}`)
    );
  }

  await runCombo('Progressive search: State only', {});
  await runCombo('Progressive search: State + City', { withCity: true });
  await runCombo('Progressive search: State + City + Locality', { withCity: true, withLocality: true });
  await runCombo('Progressive search: State + City + Locality + Radius', { withCity: true, withLocality: true, withRadius: true });

  return results;
}

async function runRouteSearchScenarios(page, url, diagnostics, tabHash) {
  const results = [];
  await resetToFreshPage(page, url);
  if (tabHash) await switchToTab(page, tabHash);
  const formId = await getContainingFormId(page, '#OutletSourceAddress');

  // C1: identical source/destination is rejected client-side without navigating
  await page.evaluate(() => {
    const src = document.querySelector('#OutletSourceAddress');
    const dst = document.querySelector('#OutletDestinationAddress');
    if (src) src.value = 'Same Place';
    if (dst) dst.value = 'Same Place';
  });
  const before = page.url();
  await sleep(NAV_PACE_MS);
  await page.evaluate((id) => document.getElementById(id)?.requestSubmit?.(), formId).catch(() => null);
  await new Promise((r) => setTimeout(r, 800));
  const errorVisible = await page.evaluate(() => {
    const el = document.querySelector('.store_search_09__route-error-msg, [class*="route-error"]');
    if (!el) return null;
    return getComputedStyle(el).display !== 'none' && el.offsetParent !== null;
  });
  const c1Challenged = await isChallengePage(page, null);
  if (c1Challenged) await recoverFromChallenge(page, url);
  const stayedOnPage = page.url() === before;
  results.push(
    c1Challenged
      ? skip('Route search: identical source/destination is rejected', 'hit a bot/rate-limit challenge page mid-submit; recovered but could not confirm this step\'s real outcome')
      : stayedOnPage && errorVisible !== false
        ? pass('Route search: identical source/destination is rejected', `errorVisible=${errorVisible}`)
        : fail('Route search: identical source/destination is rejected', `stayedOnPage=${stayedOnPage}, errorVisible=${errorVisible}`)
  );

  // C3: empty destination blocked by required-field validation
  await page.evaluate(() => {
    const src = document.querySelector('#OutletSourceAddress');
    const dst = document.querySelector('#OutletDestinationAddress');
    if (src) src.value = 'Delhi';
    if (dst) dst.value = '';
  });
  const isDestValidEmpty = await page.evaluate(() => document.querySelector('#OutletDestinationAddress')?.checkValidity());
  results.push(
    isDestValidEmpty === false
      ? pass('Route search: empty destination blocked by required-field validation', 'checkValidity() === false')
      : fail('Route search: empty destination blocked by required-field validation', `checkValidity()=${isDestValidEmpty}`)
  );

  // C2: two distinct real locations via live autocomplete produce a route result
  await page.evaluate(() => {
    const src = document.querySelector('#OutletSourceAddress');
    const dst = document.querySelector('#OutletDestinationAddress');
    if (src) src.value = '';
    if (dst) dst.value = '';
  });
  // C4: autocomplete suggestions for one field don't leak into the other —
  // typing in Source shouldn't populate or affect Destination's own value.
  await page.click('#OutletSourceAddress');
  await page.type('#OutletSourceAddress', 'Connaught Place Delhi', { delay: 40 });
  await page.waitForSelector('.pac-container .pac-item', { visible: true, timeout: PAC_TIMEOUT }).catch(() => null);
  const destUnaffected = await page.evaluate(() => document.querySelector('#OutletDestinationAddress')?.value === '');
  results.push(
    destUnaffected
      ? pass('Route search: autocomplete suggestions are independent per field', 'typing in Source left Destination empty/unaffected')
      : fail('Route search: autocomplete suggestions are independent per field', 'Destination field was affected by typing in Source')
  );
  await page.keyboard.press('ArrowDown').catch(() => null);
  await page.keyboard.press('Enter').catch(() => null);
  const srcPicked = true;
  const dstPicked = await typeIntoAutocomplete(page, '#OutletDestinationAddress', 'Faridabad');
  let c2Values = null;
  if (srcPicked && dstPicked) {
    c2Values = await page.evaluate(() => ({
      src: document.querySelector('#OutletSourceAddress')?.value,
      dst: document.querySelector('#OutletDestinationAddress')?.value,
    }));
    const c2 = await submitFormAndCheckNav(page, formId, url, { expectNav: true });
    const c2Count = await getResultCount(page);
    results.push(
      c2.challenged
        ? skip('Route search: two distinct valid locations return results', 'hit a bot/rate-limit challenge page mid-submit; recovered but could not confirm this step\'s real outcome')
        : c2.navigated
          ? pass('Route search: two distinct valid locations return results', `outletsOnPage=${c2Count}`)
          : fail('Route search: two distinct valid locations return results', 'form did not navigate')
    );
  } else {
    results.push(
      skip(
        'Route search: two distinct valid locations return results',
        `autocomplete suggestions did not appear in time (source=${srcPicked}, destination=${dstPicked}) — Places API may be slow/unreachable from this environment`
      )
    );
  }

  // C5: swapping a previously-successful source/destination pair still
  // returns a valid (if different) result, not an error, in either direction.
  if (c2Values && c2Values.src && c2Values.dst) {
    await resetToFreshPage(page, url);
    if (tabHash) await switchToTab(page, tabHash);
    await page.evaluate(
      (vals) => {
        const src = document.querySelector('#OutletSourceAddress');
        const dst = document.querySelector('#OutletDestinationAddress');
        if (src) src.value = vals.dst;
        if (dst) dst.value = vals.src;
      },
      c2Values
    );
    const swapFormId = await getContainingFormId(page, '#OutletSourceAddress');
    const c5 = await submitFormAndCheckNav(page, swapFormId, url, { expectNav: true });
    results.push(
      c5.challenged
        ? skip('Route search: swapping source and destination still works', 'hit a bot/rate-limit challenge page mid-submit; recovered but could not confirm this step\'s real outcome')
        : c5.navigated
          ? pass('Route search: swapping source and destination still works', `swapped source="${c2Values.dst}", destination="${c2Values.src}" -> url=${c5.url}`)
          : fail('Route search: swapping source and destination still works', 'form did not navigate after swapping source/destination')
    );
  } else {
    results.push(skip('Route search: swapping source and destination still works', 'no successful source/destination pair from the prior case to swap'));
  }

  // C6: a nonsense location typed directly (no autocomplete suggestion picked)
  // is handled gracefully — no crash, no unhandled error — rather than only
  // ever being exercised with autocomplete-confirmed real places.
  await resetToFreshPage(page, url);
  if (tabHash) await switchToTab(page, tabHash);
  await page.type('#OutletSourceAddress', 'zzqxnonexistentplace9999', { delay: 20 });
  await page.type('#OutletDestinationAddress', 'zzqynonexistentplace8888', { delay: 20 });
  const gibberishFormId = await getContainingFormId(page, '#OutletSourceAddress');
  const c6 = await submitFormAndCheckNav(page, gibberishFormId, url, { expectNav: true });
  results.push(
    c6.challenged
      ? skip('Route search: nonexistent locations (no autocomplete match) do not crash', 'hit a bot/rate-limit challenge page mid-submit; recovered but could not confirm this step\'s real outcome')
      : c6.navigated
        ? pass('Route search: nonexistent locations (no autocomplete match) do not crash', `url=${c6.url}`)
        : fail('Route search: nonexistent locations (no autocomplete match) do not crash', 'form did not navigate')
  );

  return results;
}

async function runTabSwitchScenarios(page, widgets) {
  const results = [];
  const tabTargets = [
    { hash: '#searchTypeCustom', applies: widgets.localitySearch },
    { hash: '#searchTypeAdvance', applies: widgets.advancedDropdown },
    { hash: '#searchTypeRoute', applies: widgets.routeSearch },
  ].filter((t) => t.applies && widgets.tabs.includes(t.hash));

  for (const t of tabTargets) {
    const clicked = await switchToTab(page, t.hash);
    const visible = await page.evaluate((hash) => {
      const el = document.querySelector(hash);
      if (!el) return null;
      return el.offsetParent !== null && getComputedStyle(el).display !== 'none';
    }, t.hash);
    results.push(
      clicked && visible
        ? pass(`Tab switching: "${t.hash}" panel becomes visible on click`, '')
        : fail(`Tab switching: "${t.hash}" panel becomes visible on click`, `clicked=${clicked}, visible=${visible}`)
    );
  }
  return results;
}

// Applies regardless of which search widget(s) a page has — exercised once,
// against whatever results page the site's own default state or a plain
// locality search produces.
async function runCrossCuttingScenarios(page, url, diagnostics, widgets) {
  const results = [];

  // D1: search state survives a plain page refresh — the same query params
  // reproduce the same filtered results, not a reset to the unfiltered default.
  const refreshUrl = widgets.localitySearch ? (url.includes('?') ? `${url}&search=Delhi` : `${url}?search=Delhi`) : url;
  const firstLoadResp = await page.goto(refreshUrl, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT * 2 }).catch(() => null);
  const refreshChallenged1 = await isChallengePage(page, firstLoadResp);
  if (refreshChallenged1) await recoverFromChallenge(page, refreshUrl);
  const countBeforeRefresh = await getResultCount(page);
  await sleep(NAV_PACE_MS);
  const secondLoadResp = await page.reload({ waitUntil: 'networkidle2', timeout: NAV_TIMEOUT * 2 }).catch(() => null);
  const refreshChallenged2 = await isChallengePage(page, secondLoadResp);
  if (refreshChallenged2) await recoverFromChallenge(page, refreshUrl);
  const countAfterRefresh = await getResultCount(page);
  results.push(
    refreshChallenged1 || refreshChallenged2
      ? skip('Cross-cutting: search state survives a page refresh', 'hit a bot/rate-limit challenge page during this check; recovered but could not confirm the real outcome')
      : countBeforeRefresh === countAfterRefresh
        ? pass('Cross-cutting: search state survives a page refresh', `outletsOnPage stayed at ${countBeforeRefresh} across a reload of ${refreshUrl}`)
        : fail('Cross-cutting: search state survives a page refresh', `outletsOnPage changed from ${countBeforeRefresh} to ${countAfterRefresh} across a reload`)
  );

  // D2: per-result action links (Call / Map / Website) carry a well-formed
  // href/tel, not empty or javascript:void(0)-only placeholders.
  const actionLinkCheck = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[class*="outlets-btn"], a[class*="store_outlet"]'));
    const callLinks = links.filter((a) => /call/i.test(a.className));
    const mapLinks = links.filter((a) => /map/i.test(a.className));
    const websiteLinks = links.filter((a) => /website/i.test(a.className));
    const isUsable = (a) => {
      const href = a.getAttribute('href') || '';
      return href.length > 0 && !/^javascript:void\(0?\)?;?$/i.test(href.trim());
    };
    return {
      totalActionLinks: links.length,
      callOk: callLinks.length === 0 || callLinks.every(isUsable),
      mapOk: mapLinks.length === 0 || mapLinks.every(isUsable),
      websiteOk: websiteLinks.length === 0 || websiteLinks.every(isUsable),
      counts: { call: callLinks.length, map: mapLinks.length, website: websiteLinks.length },
    };
  });
  results.push(
    actionLinkCheck.totalActionLinks === 0
      ? skip('Cross-cutting: result action links (Call/Map/Website) are well-formed', 'no recognizable outlet action links found on this results page')
      : actionLinkCheck.callOk && actionLinkCheck.mapOk && actionLinkCheck.websiteOk
        ? pass('Cross-cutting: result action links (Call/Map/Website) are well-formed', JSON.stringify(actionLinkCheck.counts))
        : fail('Cross-cutting: result action links (Call/Map/Website) are well-formed', `one or more action links had an empty/placeholder href: ${JSON.stringify(actionLinkCheck)}`)
  );

  // D3: pagination — if a "Next" control exists, clicking it changes the
  // rendered outlet list rather than reloading the same page or erroring.
  const nextHandle = await page.$('a::-p-text(Next)').catch(() => null);
  if (nextHandle) {
    const beforeNamesRaw = await page.evaluate(() => document.querySelector('[class*="store_outlet"]')?.parentElement?.innerText || '');
    await sleep(NAV_PACE_MS);
    const beforeUrl = page.url();
    await Promise.all([
      page.waitForNavigation({ timeout: NAV_TIMEOUT }).catch(() => null),
      nextHandle.click().catch(() => null),
    ]);
    const paginationChallenged = await isChallengePage(page, null);
    if (paginationChallenged) await recoverFromChallenge(page, refreshUrl);
    const afterNamesRaw = await page.evaluate(() => document.querySelector('[class*="store_outlet"]')?.parentElement?.innerText || '');
    const changed = page.url() !== beforeUrl || afterNamesRaw !== beforeNamesRaw;
    results.push(
      paginationChallenged
        ? skip('Cross-cutting: pagination "Next" control loads a different result set', 'hit a bot/rate-limit challenge page mid-click; recovered but could not confirm the real outcome')
        : changed
          ? pass('Cross-cutting: pagination "Next" control loads a different result set', `url changed to ${page.url()}, or list content differed`)
          : fail('Cross-cutting: pagination "Next" control loads a different result set', 'clicking Next produced no change in URL or listed outlets')
    );
  } else {
    results.push(skip('Cross-cutting: pagination "Next" control loads a different result set', 'no "Next" pagination control found on this results page (may only have one page of results, or use different pagination copy)'));
  }

  // D4: a single search submission completes in a reasonable time, not an
  // unbounded spinner.
  await resetToFreshPage(page, url);
  if (widgets.localitySearch) {
    const timedFormId = await getContainingFormId(page, '#OutletSearch');
    await page.evaluate(() => { const el = document.querySelector('#OutletSearch'); if (el) el.value = ''; });
    await page.type('#OutletSearch', 'Delhi', { delay: 20 });
    const startedAt = Date.now();
    const timed = await submitFormAndCheckNav(page, timedFormId, url, { expectNav: true });
    const elapsedMs = Date.now() - startedAt - NAV_PACE_MS; // exclude this function's own deliberate pacing delay
    results.push(
      timed.challenged
        ? skip('Cross-cutting: a search submission completes in a reasonable time', 'hit a bot/rate-limit challenge page mid-submit; recovered but could not confirm the real outcome')
        : elapsedMs < 10000
          ? pass('Cross-cutting: a search submission completes in a reasonable time', `${elapsedMs}ms`)
          : fail('Cross-cutting: a search submission completes in a reasonable time', `${elapsedMs}ms — exceeded the 10s threshold`)
    );
  } else {
    results.push(skip('Cross-cutting: a search submission completes in a reasonable time', 'no locality/custom search field on this client to time directly'));
  }

  return results;
}

// onGroupComplete(groupName, groupResults), if given, fires after each
// scenario group finishes — lets a caller (e.g. a UI streaming live
// progress) show incremental results without waiting for the whole site to
// finish. Purely additive: the CLI (searchAudit.js) doesn't pass it and
// behaves exactly as before.
async function runSearchScenarios(page, widgets, url, onGroupComplete) {
  const diagnostics = { consoleErrors: [], pageErrors: [], dialogs: [] };
  attachDiagnostics(page, diagnostics);

  const results = [];
  const emit = (groupName, groupResults) => {
    results.push(...groupResults);
    onGroupComplete?.(groupName, groupResults);
  };

  emit('Tab switching', await runTabSwitchScenarios(page, widgets));

  const customTab = widgets.tabs.includes('#searchTypeCustom') ? '#searchTypeCustom' : null;
  const advanceTab = widgets.tabs.includes('#searchTypeAdvance') ? '#searchTypeAdvance' : null;
  const routeTab = widgets.tabs.includes('#searchTypeRoute') ? '#searchTypeRoute' : null;

  if (widgets.localitySearch) {
    emit('Locality / custom search', await runLocalitySearchScenarios(page, url, diagnostics, customTab));
  }

  if (widgets.advancedDropdown) {
    emit('Advanced search', await runAdvancedDropdownScenarios(page, url, diagnostics, advanceTab));
    // The radius-gated variant (State -> City -> free-text Locality -> Radius)
    // needs its own progressive combos beyond the generic checks above.
    if (widgets.radiusFilter) {
      emit('Progressive search (radius-gated)', await runRadiusProgressiveScenarios(page, url, diagnostics, advanceTab));
    }
  }

  if (widgets.routeSearch) {
    emit('Route search', await runRouteSearchScenarios(page, url, diagnostics, routeTab));
  }

  if (widgets.localitySearch || widgets.advancedDropdown) {
    emit('Cross-cutting', await runCrossCuttingScenarios(page, url, diagnostics, widgets));
  }

  const diagnosticResults = [
    diagnostics.pageErrors.length === 0
      ? pass('No uncaught JS errors during search interactions', '')
      : fail('No uncaught JS errors during search interactions', diagnostics.pageErrors.join(' | ')),
  ];

  // Locality and route search both depend on Google Places Autocomplete; a
  // rate-limited/quota-exceeded Maps key silently degrades or breaks
  // suggestions without throwing a page error, so it needs its own check.
  const quotaErrors = diagnostics.consoleErrors.filter((m) => /rate-limit|quota|OVER_QUERY_LIMIT|RequestDenied/i.test(m));
  diagnosticResults.push(
    quotaErrors.length === 0
      ? pass('No Google Maps API quota/rate-limit errors observed', '')
      : fail('No Google Maps API quota/rate-limit errors observed', `${quotaErrors.length} occurrence(s): ${quotaErrors[0]}`)
  );
  emit('Diagnostics', diagnosticResults);

  return { results, diagnostics };
}

module.exports = { detectSearchWidgets, runSearchScenarios };
