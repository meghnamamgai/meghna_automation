'use strict';

// Shared audit-execution logic used by both the CLI (searchAudit.js) and the
// web server (server.js) — kept in one place so the two don't drift.

const puppeteer = require('puppeteer');
const { detectSearchWidgets, runSearchScenarios } = require('./searchChecks');
const { runWithConcurrency, envInt } = require('./concurrency');

async function launchBrowser() {
  return puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  });
}

// A stock headless Chrome fingerprint (navigator.webdriver === true, the
// "HeadlessChrome" UA token) trips WAF/bot-protection on some client sites
// (Cloudflare-fronted ones observed so far) into serving a 403 instead of the
// real page — while the identical request over plain curl gets a normal 200.
// This isn't evasion of a third party's protection on a site we don't
// control: these are our own clients' storelocator pages, and the goal is
// just to not be misidentified as a bot while doing legitimate QA.
async function setupRealisticPage(browser) {
  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  );
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  await page.setViewport({ width: 1366, height: 900 });
  return page;
}

// onLog(line) and onGroupComplete(groupName, groupResults) are both optional
// — the CLI passes onLog for console output; the server passes both to
// stream live progress over SSE. Neither changes the returned report shape.
async function auditSite(site, browser, { onLog, onGroupComplete } = {}) {
  const log = onLog || (() => {});
  log(`=== ${site.name} (${site.url}) ===`);
  const page = await setupRealisticPage(browser);

  try {
    await page.goto(site.url, { waitUntil: 'networkidle2', timeout: 60000 });
    const widgets = await detectSearchWidgets(page);
    log(`Detected search widgets: ${JSON.stringify(widgets)}`);

    const detected = ['localitySearch', 'advancedDropdown', 'routeSearch'].filter((k) => widgets[k]);
    if (detected.length === 0) {
      log('No recognized search widget found on this page — skipping scenario checks.');
      return { name: site.name, url: site.url, ok: true, widgets, results: [], skippedReason: 'no recognized search widget found' };
    }

    const { results, diagnostics } = await runSearchScenarios(page, widgets, site.url, onGroupComplete, () => setupRealisticPage(browser));
    for (const r of results) log(`  [${r.status}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);

    return { name: site.name, url: site.url, ok: true, widgets, results, diagnostics };
  } catch (err) {
    log(`FAILED to audit ${site.name}: ${err.message}`);
    return { name: site.name, url: site.url, ok: false, error: err.message, widgets: null, results: [] };
  } finally {
    await page.close().catch(() => {});
  }
}

// How many sites are audited at the same time. Each site gets its own browser
// tab (and, being a different host, its own rate-limit budget), so sites don't
// interfere with each other; the cap just keeps a long list from opening dozens
// of tabs at once. Override with AUDIT_CONCURRENCY (1 = one at a time).
const DEFAULT_CONCURRENCY = 3;

function getConcurrency() {
  return envInt('AUDIT_CONCURRENCY', DEFAULT_CONCURRENCY);
}

function slugify(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

module.exports = { launchBrowser, setupRealisticPage, auditSite, runWithConcurrency, getConcurrency, slugify, timestamp };
