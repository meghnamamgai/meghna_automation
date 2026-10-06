#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');
const { launchBrowser, auditSite } = require('./auditRunner');

const PORT = process.env.PORT || 4173;
const CONFIG_PATH = path.join(__dirname, '..', 'config', 'search-sites.json');
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5MB is generous for a sheet of URLs

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES } });

// ---- run tracking (in-memory; this is a local single-user tool) ----
const runs = new Map();

function createRun() {
  const runId = crypto.randomUUID();
  runs.set(runId, { emitter: new EventEmitter(), buffer: [], done: false });
  return runId;
}

function pushEvent(runId, event) {
  const run = runs.get(runId);
  if (!run) return;
  run.buffer.push(event);
  run.emitter.emit('event', event);
  if (event.type === 'run-done' || event.type === 'fatal-error') run.done = true;
}

// ---- sheet parsing (CSV or XLSX) — flexible header matching so a sheet ----
// ---- with columns like "Clients"/"URLs" (or "Name"/"URL") both work.   ----
function parseCsvBuffer(buffer) {
  const text = buffer.toString('utf8');
  const rows = [];
  let cur = '';
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(cur);
      cur = '';
    } else if (c === '\n') {
      row.push(cur);
      rows.push(row);
      row = [];
      cur = '';
    } else if (c !== '\r') {
      cur += c;
    }
  }
  if (cur.length || row.length) {
    row.push(cur);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

async function parseXlsxBuffer(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) return [];
  const rows = [];
  sheet.eachRow((row) => {
    const values = row.values.slice(1).map((v) => (v === null || v === undefined ? '' : String(v.text ?? v).trim()));
    rows.push(values);
  });
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

function rowsToSites(rows) {
  if (rows.length === 0) return { sites: [], warnings: ['File appears to be empty.'] };

  const header = rows[0].map((h) => String(h).trim().toLowerCase());
  let nameIdx = header.findIndex((h) => /client|name/.test(h));
  let urlIdx = header.findIndex((h) => /url|link/.test(h));
  let dataRows = rows.slice(1);

  // No recognizable header — assume column A = name, column B = url, and
  // treat every row (including the first) as data.
  if (nameIdx === -1 && urlIdx === -1) {
    nameIdx = 0;
    urlIdx = 1;
    dataRows = rows;
  } else if (urlIdx === -1) {
    return { sites: [], warnings: ['Could not find a URL column (expected a header containing "url" or "link").'] };
  } else if (nameIdx === -1) {
    nameIdx = urlIdx === 0 ? 1 : 0;
  }

  const sites = [];
  const warnings = [];
  const seenNames = new Map();
  dataRows.forEach((row, i) => {
    const rawUrl = (row[urlIdx] || '').trim();
    const rawName = (row[nameIdx] || '').trim();
    if (!rawUrl) {
      if (row.some((c) => c && c.trim())) warnings.push(`Row ${i + 2}: skipped, no URL found.`);
      return;
    }
    let url = rawUrl;
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    try {
      new URL(url);
    } catch {
      warnings.push(`Row ${i + 2}: "${rawUrl}" is not a valid URL, skipped.`);
      return;
    }
    let name = rawName || new URL(url).hostname;
    const baseName = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'site';
    const count = seenNames.get(baseName) || 0;
    seenNames.set(baseName, count + 1);
    name = count === 0 ? baseName : `${baseName}-${count + 1}`;
    sites.push({ name, url });
  });

  return { sites, warnings };
}

// ---- routes ----

app.get('/api/sites/config', (req, res) => {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return res.json({ sites: [] });
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    res.json({ sites: config.sites || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sites/parse', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded (field name must be "file").' });
    const ext = path.extname(req.file.originalname).toLowerCase();
    let rows;
    if (ext === '.csv' || req.file.mimetype === 'text/csv') {
      rows = parseCsvBuffer(req.file.buffer);
    } else if (ext === '.xlsx' || ext === '.xls') {
      rows = await parseXlsxBuffer(req.file.buffer);
    } else {
      return res.status(400).json({ error: `Unsupported file type "${ext}". Upload a .csv or .xlsx file.` });
    }
    const { sites, warnings } = rowsToSites(rows);
    res.json({ sites, warnings });
  } catch (err) {
    res.status(400).json({ error: `Could not parse file: ${err.message}` });
  }
});

app.post('/api/audit/start', (req, res) => {
  const sites = req.body?.sites;
  if (!Array.isArray(sites) || sites.length === 0) {
    return res.status(400).json({ error: 'Request body must include a non-empty "sites" array.' });
  }
  for (const s of sites) {
    if (!s || typeof s.url !== 'string' || !s.url) {
      return res.status(400).json({ error: 'Every site needs a non-empty "url".' });
    }
  }

  const runId = createRun();
  res.json({ runId });

  runAll(runId, sites).catch((err) => {
    pushEvent(runId, { type: 'fatal-error', message: err.message });
  });
});

app.get('/api/audit/stream/:runId', (req, res) => {
  const run = runs.get(req.params.runId);
  if (!run) return res.status(404).end();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  for (const event of run.buffer) send(event);

  if (run.done) {
    res.end();
    return;
  }

  const listener = (event) => {
    send(event);
    if (event.type === 'run-done' || event.type === 'fatal-error') res.end();
  };
  run.emitter.on('event', listener);
  req.on('close', () => run.emitter.off('event', listener));
});

async function runAll(runId, sites) {
  const browser = await launchBrowser();
  const reports = [];
  try {
    for (let i = 0; i < sites.length; i++) {
      const site = sites[i];
      pushEvent(runId, { type: 'site-start', site, index: i, total: sites.length });
      const report = await auditSite(site, browser, {
        onLog: (line) => pushEvent(runId, { type: 'log', site, index: i, line }),
        onGroupComplete: (groupName, groupResults) => pushEvent(runId, { type: 'group', site, index: i, groupName, results: groupResults }),
      });
      reports.push(report);
      pushEvent(runId, { type: 'site-done', site, index: i, report });
    }
  } finally {
    await browser.close().catch(() => {});
  }
  pushEvent(runId, { type: 'run-done', reports });
}

app.listen(PORT, () => {
  console.log(`Store locator search audit UI: http://localhost:${PORT}`);
});
