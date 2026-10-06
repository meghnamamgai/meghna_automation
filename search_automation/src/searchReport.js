'use strict';

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function buildSearchReportHtml(report) {
  const { name, url, ok, error, widgets, results = [], diagnostics } = report;

  if (!ok) {
    return `<!doctype html><html><head><meta charset="utf-8"><title>Search audit: ${esc(name)}</title></head>
<body><h1>${esc(name)}</h1><p>${esc(url)}</p><p style="color:#b00">FAILED TO LOAD: ${esc(error)}</p></body></html>`;
  }

  const detected = widgets
    ? Object.entries(widgets)
        .filter(([, v]) => v === true)
        .map(([k]) => k)
    : [];

  const rows = results
    .map(
      (r) => `<tr class="${r.status.toLowerCase()}">
        <td>${esc(r.name)}</td>
        <td class="status">${esc(r.status)}</td>
        <td>${esc(r.detail || '')}</td>
      </tr>`
    )
    .join('\n');

  const passCount = results.filter((r) => r.status === 'PASS').length;
  const failCount = results.filter((r) => r.status === 'FAIL').length;
  const skipCount = results.filter((r) => r.status === 'SKIP').length;

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Search functionality audit: ${esc(name)}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 24px; color: #222; }
  h1 { margin-bottom: 0; }
  .url { color: #666; margin-top: 4px; }
  .summary { margin: 16px 0; font-size: 14px; }
  .summary b { font-size: 16px; }
  .pass-count { color: #0a7a2f; }
  .fail-count { color: #b00020; }
  .skip-count { color: #8a6d00; }
  table { border-collapse: collapse; width: 100%; margin-top: 12px; }
  th, td { border: 1px solid #ddd; padding: 8px 10px; text-align: left; font-size: 14px; vertical-align: top; }
  th { background: #f5f5f5; }
  tr.pass .status { color: #0a7a2f; font-weight: 600; }
  tr.fail .status { color: #b00020; font-weight: 600; }
  tr.skip .status { color: #8a6d00; font-weight: 600; }
  .widgets { margin: 8px 0 16px; }
  .widgets span { display: inline-block; background: #eef; border-radius: 4px; padding: 2px 8px; margin-right: 6px; font-size: 13px; }
  .diag { margin-top: 24px; font-size: 13px; color: #555; }
</style>
</head>
<body>
  <h1>${esc(name)}</h1>
  <div class="url">${esc(url)}</div>
  <div class="widgets">Detected search widgets: ${detected.map((d) => `<span>${esc(d)}</span>`).join('') || '<em>none</em>'}</div>
  <div class="summary">
    <b>${results.length}</b> scenario(s) run —
    <span class="pass-count">${passCount} pass</span>,
    <span class="fail-count">${failCount} fail</span>,
    <span class="skip-count">${skipCount} skip</span>
  </div>
  <table>
    <thead><tr><th>Scenario</th><th>Result</th><th>Detail</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  ${
    diagnostics && (diagnostics.consoleErrors?.length || diagnostics.pageErrors?.length)
      ? `<div class="diag"><b>Console/page errors captured:</b><pre>${esc(
          [...(diagnostics.pageErrors || []), ...(diagnostics.consoleErrors || [])].join('\n')
        )}</pre></div>`
      : ''
  }
</body>
</html>`;
}

module.exports = { buildSearchReportHtml };
