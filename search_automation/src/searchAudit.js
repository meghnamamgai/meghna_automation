#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { launchBrowser, auditSite, runWithConcurrency, getConcurrency, slugify, timestamp } = require('./auditRunner');
const { buildSearchReportHtml } = require('./searchReport');

const REPORTS_DIR = path.join(__dirname, '..', 'reports', 'search-audit');
const CONFIG_PATH = path.join(__dirname, '..', 'config', 'search-sites.json');

function parseArgs(argv) {
  const args = { sites: [], all: false, url: null, name: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') args.all = true;
    else if (a === '--site') args.sites.push(argv[++i]);
    else if (a === '--url') args.url = argv[++i];
    else if (a === '--name') args.name = argv[++i];
  }
  return args;
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return { sites: [] };
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function resolveTargets(args, config) {
  if (args.url) return [{ name: args.name || slugify(args.url), url: args.url }];
  if (args.all) return config.sites;
  if (args.sites.length > 0) return config.sites.filter((s) => args.sites.includes(s.name));
  return [];
}

function printUsage() {
  console.log(`
Usage:
  node src/searchAudit.js --url https://testing.singleinterface.com/storelocator/178581 [--name nayara]
  node src/searchAudit.js --site nayara-uat          Run one (or more, repeat --site) named site from config
  node src/searchAudit.js --all                      Run every site in config/search-sites.json

Config file: config/search-sites.json
Reports written to: reports/search-audit/<site-slug>/<timestamp>/report.html (+ results.json)

A browser-based UI (upload a sheet of URLs, run, export results) is also available:
  npm run server
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const targets = resolveTargets(args, config);

  if (targets.length === 0) {
    printUsage();
    process.exit(1);
  }

  const browser = await launchBrowser();
  let siteReports;
  try {
    siteReports = await runWithConcurrency(targets, getConcurrency(), (site) =>
      auditSite(site, browser, { onLog: (line) => console.log(targets.length > 1 ? `[${site.name}] ${line}` : line) })
    );
  } finally {
    await browser.close();
  }

  const ts = timestamp();
  for (const report of siteReports) {
    const runDir = path.join(REPORTS_DIR, slugify(report.name), ts);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'results.json'), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(runDir, 'report.html'), buildSearchReportHtml(report));
    console.log(`Report written: ${path.join(runDir, 'report.html')}`);
  }

  console.log('\n=== Summary ===');
  for (const r of siteReports) {
    if (!r.ok) {
      console.log(`${r.name}: FAILED TO LOAD — ${r.error}`);
      continue;
    }
    const passCount = r.results.filter((x) => x.status === 'PASS').length;
    const failCount = r.results.filter((x) => x.status === 'FAIL').length;
    const skipCount = r.results.filter((x) => x.status === 'SKIP').length;
    console.log(`${r.name}: ${passCount} pass, ${failCount} fail, ${skipCount} skip`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
