'use strict';

let sites = [];
let siteReports = new Map(); // name -> { url, widgets, results: [], ok, error, done }
let expandedRows = new Set();
let running = false;

const sitesTbody = document.getElementById('sites-tbody');
const sitesEmptyHint = document.getElementById('sites-empty-hint');
const importWarnings = document.getElementById('import-warnings');
const fileInput = document.getElementById('file-input');
const loadConfigBtn = document.getElementById('load-config-btn');
const addRowBtn = document.getElementById('add-row-btn');
const runBtn = document.getElementById('run-btn');
const runStatus = document.getElementById('run-status');
const siteCards = document.getElementById('site-cards');
const logOutput = document.getElementById('log-output');
const exportBtn = document.getElementById('export-btn');

// ---- validation ----

const NAME_PATTERN = /^[A-Za-z0-9 ]*$/;

function isValidName(name) {
  return NAME_PATTERN.test(name || '');
}

// A real hostname: localhost, an IPv4 address, or dotted labels ending in a
// letters-only TLD. Needed because the browser's URL constructor is more
// lenient than it looks — `new URL("https://not a url")` doesn't throw, it
// silently percent-encodes the spaces into the hostname ("not%20a%20url"),
// so checking "did it throw" alone lets garbage through.
const HOSTNAME_PATTERN = /^(localhost|(\d{1,3}\.){3}\d{1,3}|([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})$/i;

// Accepts a URL typed with or without a protocol (matching the same
// leniency the sheet-upload parser on the server applies) and reports both
// whether it's valid and the normalized form to actually send when running.
function normalizeAndValidateUrl(raw) {
  const v = (raw || '').trim();
  if (!v) return { valid: true, empty: true, normalized: '' };
  let normalized = v;
  if (!/^https?:\/\//i.test(normalized)) normalized = `https://${normalized}`;
  try {
    const parsed = new URL(normalized);
    if (!/^https?:$/.test(parsed.protocol)) return { valid: false, empty: false, normalized: v };
    if (!HOSTNAME_PATTERN.test(parsed.hostname)) return { valid: false, empty: false, normalized: v };
    return { valid: true, empty: false, normalized };
  } catch {
    return { valid: false, empty: false, normalized: v };
  }
}

function allRowsValid() {
  return sites.every((s) => isValidName(s.name) && normalizeAndValidateUrl(s.url).valid);
}

function hasAtLeastOneRunnableSite() {
  return sites.some((s) => {
    const u = normalizeAndValidateUrl(s.url);
    return !u.empty && u.valid;
  });
}

// ---- sites table ----

function renderSites() {
  sitesTbody.innerHTML = '';
  sitesEmptyHint.hidden = sites.length > 0;
  sites.forEach((site, i) => {
    const tr = document.createElement('tr');

    const nameTd = document.createElement('td');
    const nameInput = document.createElement('input');
    nameInput.value = site.name;
    nameInput.placeholder = 'name';
    const nameError = document.createElement('div');
    nameError.className = 'field-error';
    const validateName = () => {
      const valid = isValidName(nameInput.value);
      nameInput.classList.toggle('invalid', !valid);
      nameError.textContent = valid ? '' : 'Letters, numbers, and spaces only.';
      return valid;
    };
    nameInput.addEventListener('input', () => {
      sites[i].name = nameInput.value;
      validateName();
      updateRunButton();
    });
    validateName();
    nameTd.append(nameInput, nameError);

    const urlTd = document.createElement('td');
    const urlInput = document.createElement('input');
    urlInput.value = site.url;
    urlInput.placeholder = 'https://example.com/storelocator/123';
    const urlError = document.createElement('div');
    urlError.className = 'field-error';
    const validateUrl = () => {
      const result = normalizeAndValidateUrl(urlInput.value);
      const invalid = !result.valid;
      urlInput.classList.toggle('invalid', invalid);
      urlError.textContent = invalid ? 'Enter a valid URL, e.g. example.com/storelocator/123.' : '';
      return result.valid;
    };
    urlInput.addEventListener('input', () => {
      sites[i].url = urlInput.value;
      validateUrl();
      updateRunButton();
    });
    validateUrl();
    urlTd.append(urlInput, urlError);

    const actionTd = document.createElement('td');
    const removeBtn = document.createElement('button');
    removeBtn.className = 'secondary small remove-btn';
    removeBtn.textContent = 'Remove';
    removeBtn.disabled = running;
    removeBtn.addEventListener('click', () => {
      if (running) return;
      sites.splice(i, 1);
      resetRunPanel();
      renderSites();
    });
    actionTd.appendChild(removeBtn);

    tr.append(nameTd, urlTd, actionTd);
    sitesTbody.appendChild(tr);
  });
  updateRunButton();
}

function updateRunButton() {
  runBtn.disabled = running || sites.length === 0 || !allRowsValid() || !hasAtLeastOneRunnableSite();
  // Removing a site mid-run would leave the live results out of sync with the list.
  sitesTbody.querySelectorAll('.remove-btn').forEach((b) => { b.disabled = running; });
}

// Clears everything from the previous run (results table, live log, status,
// export) so "2. Run" and "3. Export" don't keep showing results for a site
// list that no longer matches.
function resetRunPanel() {
  siteReports = new Map();
  expandedRows = new Set();
  siteCards.innerHTML = '';
  logOutput.textContent = '';
  runStatus.textContent = '';
  exportBtn.disabled = true;
}

function showWarnings(warnings) {
  if (!warnings || warnings.length === 0) {
    importWarnings.hidden = true;
    return;
  }
  importWarnings.hidden = false;
  importWarnings.innerHTML = `<strong>${warnings.length} warning(s):</strong><ul>${warnings
    .map((w) => `<li>${escapeHtml(w)}</li>`)
    .join('')}</ul>`;
}

function mergeSites(newSites) {
  const existingUrls = new Set(sites.map((s) => s.url));
  for (const s of newSites) {
    if (!existingUrls.has(s.url)) {
      sites.push(s);
      existingUrls.add(s.url);
    }
  }
  renderSites();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0];
  if (!file) return;
  const formData = new FormData();
  formData.append('file', file);
  try {
    const res = await fetch('/api/sites/parse', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) {
      showWarnings([data.error || 'Failed to parse file.']);
      return;
    }
    showWarnings(data.warnings);
    mergeSites(data.sites);
  } catch (err) {
    showWarnings([`Upload failed: ${err.message}`]);
  } finally {
    fileInput.value = '';
  }
});

loadConfigBtn.addEventListener('click', async () => {
  try {
    const res = await fetch('/api/sites/config');
    const data = await res.json();
    if (!data.sites || data.sites.length === 0) {
      showWarnings(['No saved sites found in config/search-sites.json.']);
      return;
    }
    mergeSites(data.sites);
  } catch (err) {
    showWarnings([`Could not load saved sites: ${err.message}`]);
  }
});

addRowBtn.addEventListener('click', () => {
  sites.push({ name: '', url: '' });
  renderSites();
  const lastInput = sitesTbody.querySelector('tr:last-child td:first-child input');
  lastInput?.focus();
});

// ---- run results (Name / URL / Status, click a row to expand detail) ----

function computeStatus(report) {
  if (!report.done) return { text: 'Running…', cls: 'status-running' };
  if (!report.ok) return { text: 'FAIL', cls: 'status-fail' };
  const hasFail = report.results.some((r) => r.status === 'FAIL');
  return hasFail ? { text: 'FAIL', cls: 'status-fail' } : { text: 'PASS', cls: 'status-pass' };
}

function renderDetail(report) {
  if (!report.done) return '<em>Running…</em>';
  if (!report.ok) return `Error: ${escapeHtml(report.error || '')}`;
  if (report.results.length === 0) return 'No recognized search widget found on this page.';
  return `<table class="scenario-table"><tbody>${report.results
    .map((r) => `<tr class="${r.status}"><td class="status">${r.status}</td><td>${escapeHtml(r.name)}</td><td>${escapeHtml(r.detail || '')}</td></tr>`)
    .join('')}</tbody></table>`;
}

function renderResultsTable() {
  if (siteReports.size === 0) {
    siteCards.innerHTML = '';
    return;
  }
  const bodyRows = [];
  // siteReports is keyed by run index, not name — two sites can share a
  // blank or duplicate name (e.g. every freshly-added row starts blank),
  // and a name-keyed map would silently drop all but the last one.
  for (const [index, report] of siteReports.entries()) {
    const status = computeStatus(report);
    const label = report.name && report.name.trim() ? report.name : '(unnamed)';
    bodyRows.push(
      `<tr class="result-row ${status.cls}" data-index="${index}"><td>${escapeHtml(label)}</td><td class="site-url-cell">${escapeHtml(report.url)}</td><td class="status-cell">${status.text}</td></tr>`
    );
    if (expandedRows.has(index)) {
      bodyRows.push(`<tr class="detail-row"><td colspan="3">${renderDetail(report)}</td></tr>`);
    }
  }
  siteCards.innerHTML = `<table class="results-table"><thead><tr><th>Name</th><th>URL</th><th>Status</th></tr></thead><tbody>${bodyRows.join('')}</tbody></table><p class="hint">Click a row to see the individual scenario checks.</p>`;

  siteCards.querySelectorAll('tr.result-row').forEach((tr) => {
    tr.addEventListener('click', () => {
      const index = Number(tr.dataset.index);
      if (expandedRows.has(index)) expandedRows.delete(index);
      else expandedRows.add(index);
      renderResultsTable();
    });
  });
}

function log(line) {
  logOutput.textContent += line + '\n';
  logOutput.scrollTop = logOutput.scrollHeight;
}

runBtn.addEventListener('click', async () => {
  if (sites.length === 0) return;
  running = true;
  updateRunButton();
  exportBtn.disabled = true;
  expandedRows = new Set();
  siteCards.innerHTML = '';
  logOutput.textContent = '';
  siteReports = new Map();
  runStatus.textContent = 'Starting…';

  const validSites = sites
    .filter((s) => normalizeAndValidateUrl(s.url).valid && !normalizeAndValidateUrl(s.url).empty)
    .map((s) => ({ name: s.name || '', url: normalizeAndValidateUrl(s.url).normalized }));

  if (validSites.length === 0) {
    runStatus.textContent = 'No valid URLs to run.';
    running = false;
    updateRunButton();
    return;
  }

  try {
    const startRes = await fetch('/api/audit/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sites: validSites }),
    });
    const startData = await startRes.json();
    if (!startRes.ok) {
      runStatus.textContent = `Error: ${startData.error}`;
      running = false;
      updateRunButton();
      return;
    }

    const evtSource = new EventSource(`/api/audit/stream/${startData.runId}`);

    evtSource.onmessage = (msg) => {
      const event = JSON.parse(msg.data);
      handleEvent(event);
      if (event.type === 'run-done' || event.type === 'fatal-error') {
        evtSource.close();
        running = false;
        updateRunButton();
      }
    };

    evtSource.onerror = () => {
      runStatus.textContent = 'Connection lost.';
      evtSource.close();
      running = false;
      updateRunButton();
    };
  } catch (err) {
    runStatus.textContent = `Error: ${err.message}`;
    running = false;
    updateRunButton();
  }
});

// Several sites can be audited at once, so progress is "N of M finished"
// rather than "site i of M".
let validSitesTotal = 0;
function updateProgress(total) {
  validSitesTotal = total;
  const reports = [...siteReports.values()];
  const done = reports.filter((r) => r.done).length;
  const active = reports.length - done;
  runStatus.textContent = `Running — ${done}/${total} finished${active > 0 ? `, ${active} in progress` : ''}`;
}

function handleEvent(event) {
  switch (event.type) {
    case 'site-start':
      siteReports.set(event.index, { name: event.site.name, url: event.site.url, widgets: null, results: [], done: false, ok: null });
      updateProgress(event.total);
      renderResultsTable();
      break;
    case 'log':
      log(event.line);
      break;
    case 'group': {
      const r = siteReports.get(event.index);
      if (r) {
        r.results.push(...event.results);
        if (expandedRows.has(event.index)) renderResultsTable();
      }
      break;
    }
    case 'site-done': {
      const r = siteReports.get(event.index);
      if (r) {
        r.done = true;
        r.ok = event.report.ok;
        r.error = event.report.error;
        r.widgets = event.report.widgets;
        // Groups can finish out of order when they run in parallel; the final
        // report has them in a stable order, so prefer it over the streamed order.
        if (event.report.results && event.report.results.length) r.results = event.report.results;
        updateProgress(validSitesTotal);
        renderResultsTable();
      }
      break;
    }
    case 'run-done':
      runStatus.textContent = `Done — ${event.reports.length} site(s).`;
      exportBtn.disabled = false;
      break;
    case 'fatal-error':
      runStatus.textContent = `Fatal error: ${event.message}`;
      break;
  }
}

function csvEscape(value) {
  const s = String(value ?? '');
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

exportBtn.addEventListener('click', () => {
  const header = ['Client Name', 'Client URL', 'Detected Widgets', 'Scenario', 'Status', 'Detail'];
  const rows = [header];

  for (const report of siteReports.values()) {
    const name = report.name && report.name.trim() ? report.name : '';
    const widgetList = report.widgets
      ? Object.entries(report.widgets).filter(([, v]) => v === true).map(([k]) => k).join('; ')
      : '';
    if (!report.ok) {
      rows.push([name, report.url, widgetList, 'FAILED TO LOAD', 'FAIL', report.error || '']);
      continue;
    }
    if (report.results.length === 0) {
      rows.push([name, report.url, widgetList, 'No recognized search widget found', 'SKIP', '']);
      continue;
    }
    for (const r of report.results) {
      rows.push([name, report.url, widgetList, r.name, r.status, r.detail || '']);
    }
  }

  const csv = rows.map((row) => row.map(csvEscape).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `search-audit-results-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

renderSites();
