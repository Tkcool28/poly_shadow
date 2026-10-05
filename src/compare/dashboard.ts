/**
 * Phase 4 read-only comparison dashboard generator.
 *
 *   tsx src/compare/dashboard.ts <outDir> [shadowDataDir]
 *
 * Reads <outDir>/comparison.json (+ optional Shadow data dir for source
 * health) and writes <outDir>/dashboard.html — a single self-contained,
 * phone-friendly static page. No trading controls, no Poly2 access, no
 * network calls; the page renders embedded artifacts only (handoff §13/§14).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ComparisonResult } from './phase4.js';

const [, , outDir, dataDir] = process.argv;
if (!outDir) {
  console.error('usage: tsx src/compare/dashboard.ts <outDir> [shadowDataDir]');
  process.exit(1);
}
const comparison = JSON.parse(readFileSync(join(outDir, 'comparison.json'), 'utf8')) as ComparisonResult;

function readRows(dir: string, name: string): Array<Record<string, unknown>> {
  const f = join(dir, name);
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

// Live source health (best-effort; absent when no data dir is supplied).
let health: Record<string, unknown> = { available: false };
if (dataDir) {
  const tel = readRows(dataDir, 'poll_telemetry.ndjson');
  const quar = readRows(dataDir, 'quarantine.ndjson');
  const obs = readRows(dataDir, 'source_observations.ndjson');
  const chainRaw = readRows(dataDir, 'raw_logs.ndjson');
  const last = (a: Array<Record<string, unknown>>, k: string) =>
    a.length ? String(a[a.length - 1]![k] ?? '') : null;
  const errors = tel.filter((t) => t['error']);
  const ages = tel.map((t) => Number(t['ageHeader'])).filter((a) => !Number.isNaN(a)).sort((a, b) => a - b);
  health = {
    available: true,
    chainRawEvents: chainRaw.length,
    latestObservationUtc: last(obs, 'completedUtc'),
    restPolls: tel.length,
    restErrors: errors.length,
    lastRestError: errors.length ? String(errors[errors.length - 1]!['error']).slice(0, 120) : null,
    cdnAgeP50Sec: ages.length ? ages[Math.floor(ages.length / 2)] : null,
    quarantineCount: quar.length,
    recoveryRequired: quar.some((q) => (q['detail'] as Record<string, unknown>)?.['recoveryRequired'] === true),
  };
}

const fmtDelta = (d: number | null): string =>
  d === null ? '—' : `${d >= 0 ? '+' : ''}${d.toFixed(1)}s`;

const rowsHtml = comparison.records
  .filter((r) => r.poly2Index !== null || r.match === 'SHADOW_ONLY')
  .map((r, i) => `<tr data-wallet="${r.wallet ?? ''}" data-match="${r.match}" data-decision="${r.decision ?? ''}"
      data-raw="${r.rawDeltaSec ?? ''}">
    <td>${r.wallet ? r.wallet.slice(0, 8) + '…' : '—'}</td>
    <td><span class="pill ${r.match.toLowerCase().replace(/_/g, '-')}">${r.match}</span></td>
    <td class="num">${fmtDelta(r.rawDeltaSec)}</td>
    <td class="num">${fmtDelta(r.usableDeltaSec)}</td>
    <td>${r.decision ?? '—'}</td>
    <td>${r.note ?? ''}</td></tr>`)
  .join('\n');

const perWallet = new Map<string, { matched: number; shadowOnly: number; poly2Only: number; rawDeltas: number[]; usableDeltas: number[] }>();
for (const r of comparison.records) {
  if (!r.wallet) continue;
  const w = perWallet.get(r.wallet) ?? { matched: 0, shadowOnly: 0, poly2Only: 0, rawDeltas: [], usableDeltas: [] };
  if (r.match === 'SHADOW_ONLY') w.shadowOnly++;
  else if (r.match === 'POLY2_ONLY') w.poly2Only++;
  else if (r.match === 'AMBIGUOUS') { /* visible but not in either tally */ }
  else w.matched++;
  if (r.rawDeltaSec !== null) w.rawDeltas.push(r.rawDeltaSec);
  if (r.usableDeltaSec !== null) w.usableDeltas.push(r.usableDeltaSec);
  perWallet.set(r.wallet, w);
}
const med = (a: number[]) => a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]!.toFixed(1) + 's' : '—';
const walletRows = [...perWallet.entries()].map(([w, s]) =>
  `<tr><td title="${w}">${w.slice(0, 8)}…</td><td class="num">${s.matched}</td><td class="num">${s.shadowOnly}</td>
   <td class="num">${s.poly2Only}</td><td class="num">${med(s.rawDeltas)}</td><td class="num">${med(s.usableDeltas)}</td></tr>`).join('\n');

const c = comparison.coverage;
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Poly-Shadow × Poly2 — Phase 4 comparison</title>
<style>
:root{color-scheme:dark;--bg:#0d1117;--card:#161b22;--line:#30363d;--fg:#e6edf3;--dim:#8b949e;--acc:#58a6ff;--good:#3fb950;--bad:#f85149;--warn:#d29922}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
header{padding:16px;border-bottom:1px solid var(--line)}h1{font-size:18px;margin:0}h2{font-size:15px;margin:0 0 10px;color:var(--dim);text-transform:uppercase;letter-spacing:.06em}
.sub{color:var(--dim);font-size:13px;margin-top:4px}
section{padding:16px;border-bottom:1px solid var(--line)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px}
.card .v{font-size:22px;font-weight:650}.card .l{font-size:12px;color:var(--dim)}
.good{color:var(--good)}.bad{color:var(--bad)}.warn{color:var(--warn)}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{padding:7px 8px;text-align:left;border-bottom:1px solid var(--line)}
th{color:var(--dim);font-weight:500;position:sticky;top:0;background:var(--bg)}
.num{text-align:right;font-variant-numeric:tabular-nums}
.wrap{overflow-x:auto}
.pill{font-size:11px;padding:2px 8px;border-radius:99px;border:1px solid var(--line);white-space:nowrap}
.pill.matched-high-confidence{color:var(--good);border-color:var(--good)}.pill.matched-probable{color:var(--acc);border-color:var(--acc)}
.pill.shadow-only{color:var(--warn);border-color:var(--warn)}.pill.poly2-only{color:var(--bad);border-color:var(--bad)}.pill.ambiguous{color:var(--dim)}
.filters{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px}
select,input{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:6px 10px;font-size:13px}
.note{color:var(--dim);font-size:12px;margin-top:12px}
</style></head><body>
<header>
  <h1>Poly-Shadow × Poly2 — controlled comparison</h1>
  <div class="sub">Window ${comparison.window.startUtc} → ${comparison.window.endUtc} · cohort ${comparison.cohort} ·
  read-only artifacts · generated ${new Date().toISOString()}</div>
</header>

<section><h2>Overview</h2><div class="grid">
  <div class="card"><div class="v">${c.matched}</div><div class="l">matched</div></div>
  <div class="card"><div class="v warn">${c.shadowOnly}</div><div class="l">Shadow-only</div></div>
  <div class="card"><div class="v bad">${c.poly2Only}</div><div class="l">Poly2-only</div></div>
  <div class="card"><div class="v">${c.ambiguous}</div><div class="l">ambiguous</div></div>
  <div class="card"><div class="v good">${comparison.raw.shadowEarlier}</div><div class="l">Shadow raw wins</div></div>
  <div class="card"><div class="v">${comparison.raw.poly2Earlier}</div><div class="l">Poly2 raw wins</div></div>
  <div class="card"><div class="v good">${comparison.usable.shadowEarlier}</div><div class="l">Shadow usable wins</div></div>
  <div class="card"><div class="v">${comparison.usable.poly2Earlier}</div><div class="l">Poly2 usable wins</div></div>
</div></section>

<section><h2>Live source health</h2><div class="grid" id="health"></div></section>

<section><h2>Wallets</h2><div class="wrap"><table>
<thead><tr><th>wallet</th><th class="num">matched</th><th class="num">Shadow-only</th><th class="num">Poly2-only</th><th class="num">median raw Δ</th><th class="num">median usable Δ</th></tr></thead>
<tbody>${walletRows || '<tr><td colspan="6">no records</td></tr>'}</tbody></table></div></section>

<section><h2>Trade comparison</h2>
<div class="filters">
  <input id="fWallet" placeholder="wallet…" oninput="applyFilters()">
  <select id="fMatch" onchange="applyFilters()"><option value="">match: all</option>
    <option>MATCHED_HIGH_CONFIDENCE</option><option>MATCHED_PROBABLE</option>
    <option>SHADOW_ONLY</option><option>POLY2_ONLY</option><option>AMBIGUOUS</option></select>
  <select id="fFirst" onchange="applyFilters()"><option value="">winner: all</option>
    <option value="shadow">Shadow first</option><option value="poly2">Poly2 first</option></select>
  <select id="fDecision" onchange="applyFilters()"><option value="">decision: all</option>
    <option>EARLIER_AND_USABLE</option><option>EARLIER_BUT_NOT_HYDRATED</option>
    <option>EARLIER_BUT_POLICY_INELIGIBLE</option><option>EARLIER_MAKER_ONLY</option>
    <option>EARLIER_BUT_TOO_LATE</option><option>NO_MEANINGFUL_ADVANTAGE</option></select>
</div>
<div class="wrap"><table id="trades"><thead><tr>
<th>wallet</th><th>match</th><th class="num">raw Δ</th><th class="num">usable Δ</th><th>decision</th><th>note</th>
</tr></thead><tbody>${rowsHtml || '<tr><td colspan="6">no records</td></tr>'}</tbody></table></div>
<div class="note">Δ = Poly2 time − Shadow time; positive means Shadow was earlier. Ties &lt; 1s.</div></section>

<section><h2>Coverage</h2><div class="grid">
  <div class="card"><div class="v">${c.shadowCoveragePct === null ? '—' : (c.shadowCoveragePct * 100).toFixed(1) + '%'}</div><div class="l">Shadow coverage of union (ambiguous excluded)</div></div>
  <div class="card"><div class="v">${c.poly2CoveragePct === null ? '—' : (c.poly2CoveragePct * 100).toFixed(1) + '%'}</div><div class="l">Poly2 coverage of union</div></div>
</div></section>

<section><h2>Latency (matched events, seconds)</h2><div class="grid">
  <div class="card"><div class="v">${comparison.raw.p50 ?? '—'}</div><div class="l">raw P50</div></div>
  <div class="card"><div class="v">${comparison.raw.p90 ?? '—'}</div><div class="l">raw P90</div></div>
  <div class="card"><div class="v">${comparison.raw.p95 ?? '—'}</div><div class="l">raw P95</div></div>
  <div class="card"><div class="v">${comparison.usable.p50 ?? '—'}</div><div class="l">usable P50</div></div>
  <div class="card"><div class="v">${comparison.usable.p90 ?? '—'}</div><div class="l">usable P90</div></div>
  <div class="card"><div class="v">${comparison.usable.p95 ?? '—'}</div><div class="l">usable P95</div></div>
</div></section>

<section><h2>Policy impact</h2><div class="grid">
  <div class="card"><div class="v">${comparison.policy.staleRejected}</div><div class="l">Poly2 stale-rejected (matched)</div></div>
  <div class="card"><div class="v good">${comparison.policy.staleRejectedShadowSawWithin300s}</div><div class="l">…of which Shadow saw within 300s budget</div></div>
  <div class="card"><div class="v">${Object.entries(comparison.decisionRelevance).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`).join('<br>')}</div><div class="l">decision relevance of earlier Shadow evidence</div></div>
</div>
<div class="note">Single small runs do not establish superiority — see PHASE4_COMPARISON_CONTRACT.md §8 (frozen window protocol).</div></section>

<script>
const HEALTH = ${JSON.stringify(health)};
(function(){
  const el = document.getElementById('health');
  if (!HEALTH.available) { el.innerHTML = '<div class="card"><div class="v">—</div><div class="l">no live data dir supplied (artifact-only view)</div></div>'; return; }
  const card=(v,l,cls='')=>'<div class="card"><div class="v '+cls+'">'+v+'</div><div class="l">'+l+'</div></div>';
  el.innerHTML =
    card(HEALTH.chainRawEvents,'CHAIN raw events') +
    card(HEALTH.restPolls+' / '+HEALTH.restErrors,'REST polls / errors', HEALTH.restErrors?'warn':'') +
    card(HEALTH.cdnAgeP50Sec===null?'—':HEALTH.cdnAgeP50Sec+'s','CDN age P50') +
    card(HEALTH.quarantineCount,'quarantines', HEALTH.quarantineCount?'warn':'') +
    card(HEALTH.recoveryRequired?'YES':'no','recoveryRequired', HEALTH.recoveryRequired?'bad':'good') +
    card((HEALTH.latestObservationUtc||'—').slice(0,19).replace('T',' '),'latest observation (UTC)');
})();
function applyFilters(){
  const w=document.getElementById('fWallet').value.toLowerCase();
  const m=document.getElementById('fMatch').value;
  const f=document.getElementById('fFirst').value;
  const d=document.getElementById('fDecision').value;
  document.querySelectorAll('#trades tbody tr').forEach(tr=>{
    if(!tr.dataset.wallet){tr.style.display='';return;}
    let show = (!w || tr.dataset.wallet.includes(w)) && (!m || tr.dataset.match===m) && (!d || tr.dataset.decision===d);
    if(show && f){const r=parseFloat(tr.dataset.raw||'NaN');show=f==='shadow'?r>=1:r<=-1;}
    tr.style.display=show?'':'none';
  });
}
</script>
</body></html>`;

writeFileSync(join(outDir, 'dashboard.html'), html);
console.log(`[dashboard] wrote ${join(outDir, 'dashboard.html')} (${(html.length / 1024).toFixed(0)} KB, self-contained)`);
