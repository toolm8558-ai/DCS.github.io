'use strict';
const $ = id => document.getElementById(id);
const IST = 330 * 60000, DAY = 86400000;
const params = new URLSearchParams(location.search);
if (params.get('embed') === '1') document.body.classList.add('embed');

let key = sessionStorage.getItem('trendKey') || '';
if (location.hash.startsWith('#key=')) {
  key = decodeURIComponent(location.hash.slice(5));
  sessionStorage.setItem('trendKey', key);
  history.replaceState(null, '', location.pathname + location.search);
}

let state = { tag: params.get('tag') || '', from: params.get('from') || '', to: params.get('to') || '' };
let data = null, hover = null, request = 0;

// All dates on this page are India time, whatever the viewer's computer is set to.
const pad = n => String(n).padStart(2, '0');
function ist(ms) {
  const d = new Date(ms + IST);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() };
}
const fmtDate = ms => { const t = ist(ms); return `${pad(t.d)}-${pad(t.mo)}-${t.y}`; };
const fmtTime = ms => { const t = ist(ms); return `${pad(t.h)}:${pad(t.mi)}`; };
const fmtSec = ms => { const t = ist(ms); return `${pad(t.h)}:${pad(t.mi)}:${pad(t.s)}`; };
const isoDate = ms => { const t = ist(ms); return `${t.y}-${pad(t.mo)}-${pad(t.d)}`; };
const isoLocal = ms => `${isoDate(ms)}T${fmtTime(ms)}`;
const todayStart = () => Date.parse(`${isoDate(Date.now())}T00:00:00Z`) - IST;
const num = v => (v === null || v === undefined ? '' : Number(v).toLocaleString('en-IN', { maximumFractionDigits: 3 }));

async function api(path) {
  const res = await fetch(path, { headers: { 'x-api-key': key } });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) { showKey('That key is not right.'); throw new Error('unauthorized'); }
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

function showKey(error) {
  sessionStorage.removeItem('trendKey');
  $('app').hidden = true;
  $('keyForm').hidden = false;
  $('keyError').textContent = error || '';
}

$('keyForm').addEventListener('submit', e => {
  e.preventDefault();
  key = $('keyInput').value.trim();
  sessionStorage.setItem('trendKey', key);
  start();
});

async function start() {
  if (!key) return showKey();
  try {
    const status = await api('/api/status');
    $('keyForm').hidden = true;
    $('app').hidden = false;
    const s = status[0];
    if (s && s.newestData) $('fresh').textContent = `Data up to ${fmtDate(Date.parse(s.newestData))} ${fmtTime(Date.parse(s.newestData))}`;
    if (!state.from) setDays(1, false);
    syncInputs();
    drawGroupBar();
    loadGroup();
    if (state.tag) { $('tagInput').value = state.tag; load(); }
  } catch (e) {
    if (e.message !== 'unauthorized') showKey(e.message);
  }
}

// Tag groups shown as an overview. Only tags that have data in the chosen range are drawn.
const GROUPS = [
  { name: 'Vibration, displacement and bearing temperature', tags: `ZIA_201A.PV ZIA_201B.PV ZIA_202.PV VIA_201A.PV VIA_201B.PV VIB_202A.PV VIB_202B.PV VIB_203A.PV VIB_203B.PV VIB_204A.PV VIB_204B.PV VI_205A.PV VI_205B.PV VI_206A.PV VI_206B.PV VI_251A.PV VI_251B.PV VI_252A.PV VI_252B.PV TE_201.PV TE_202.PV TE_203.PV TE_204.PV TE_205.PV TE_206.PV TE_207.PV TE_208.PV GEN_DE GEN_NDE`.split(' ') },
  { name: 'Process (load, pressure, temperature, flow, level)', tags: `TG_LOAD.PV PT_02.PV TT_07ABC FT_02_COMP LT_01_FINAL FW_FLOW_TOT PT100_FINAL FT200_FINAL FT_201.PV PT_01.PV ZT_S01 PT_26.PV TE_100_1.PV TE_01.PV TE_02.PV TE_10.PV TT_03.PV TT_04.PV TT_05.PV TE_13.PV TE_26.PV TE_200.PV TE_201.PV DT_200.PV DT_201.PV DT_203.PV PT_100A.PV PT_100B.PV DT_101.PV DT_109.PV DT_102.PV DT_103.PV DT_104.PV TE_102.PV TE_105.PV TE_106.PV TE_107.PV AT_100.PV LT_51AVG LT_53.PV TE_104.PV FT_03.PV BAG_FLOW_TOTAL`.split(' ') }
];
let groupIdx = Number(params.get('group') || -1), groupReq = 0;

function drawGroupBar() {
  const bar = $('groupBar');
  bar.replaceChildren(...GROUPS.map((g, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = `${g.name} (${g.tags.length})`;
    b.classList.toggle('on', i === groupIdx);
    b.addEventListener('click', () => { groupIdx = i; drawGroupBar(); loadGroup(); });
    return b;
  }));
}

function spark(d) {
  const W = 200, H = 34, known = d.points.filter(p => p.v !== undefined);
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none' });
  if (known.length < 2) return svg;
  const band = d.bucketMinutes > 1 && d.type !== 'BOOL', val = p => (band ? p.avg : p.v);
  const vs = known.map(val), lo = Math.min(...vs), hi = Math.max(...vs);
  const x = t => (t - d.from) / (d.to - d.from) * W, y = v => H - 3 - (v - lo) / ((hi - lo) || 1) * (H - 6);
  let run = [];
  const flush = () => { if (run.length > 1) el('polyline', { points: run.join(' '), fill: 'none', stroke: 'var(--series)', 'stroke-width': 1.5, 'vector-effect': 'non-scaling-stroke' }, svg); run = []; };
  for (const p of d.points) { if (p.v === undefined) flush(); else run.push(`${x(p.t).toFixed(1)},${y(val(p)).toFixed(1)}`); }
  flush();
  return svg;
}

function ovCard(d) {
  const s = d.summary, band = d.bucketMinutes > 1 && d.type !== 'BOOL';
  const last = [...d.points].reverse().find(p => p.v !== undefined);
  const whole = Math.round((d.to - d.from) / 60000);
  const c = document.createElement('button');
  c.type = 'button'; c.className = 'ocard'; c.dataset.tag = d.tag;
  const nm = document.createElement('div'); nm.className = 'nm'; nm.textContent = d.tag;
  const ds = document.createElement('div'); ds.className = 'ds'; ds.textContent = d.description || ''; ds.title = d.description || '';
  const vl = document.createElement('div'); vl.className = 'vl';
  const v = last ? (band ? last.avg : last.v) : null;
  vl.textContent = v === null ? '-' : num(v);
  if (d.unit) { const u = document.createElement('small'); u.textContent = ` ${d.unit}`; vl.append(u); }
  const mm = document.createElement('div'); mm.className = 'mm';
  mm.textContent = d.type === 'BOOL' ? `On ${num(s.hoursAt1)} h, starts ${s.starts}` : `Min ${num(s.min)}  Max ${num(s.max)}  Avg ${num(s.avg)}`;
  const rc = document.createElement('div'); rc.className = 'mm'; rc.textContent = `Recorded ${Math.round(s.minutes / whole * 100)}%`;
  c.append(nm, ds, vl, spark(d), mm, rc);
  c.addEventListener('click', () => { pick(d.tag); $('result').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  return c;
}

async function loadGroup() {
  if (groupIdx < 0 || !GROUPS[groupIdx]) { $('overview').hidden = true; return; }
  const g = GROUPS[groupIdx], id = ++groupReq;
  $('overview').hidden = false;
  $('ovTitle').textContent = g.name;
  $('ovStat').textContent = 'Loading...';
  $('ovGrid').replaceChildren();
  $('ovNone').hidden = true;
  $('message').hidden = true;
  const query = tag => `tag=${encodeURIComponent(tag)}&from=${encodeURIComponent(state.from)}&to=${encodeURIComponent(state.to)}`;
  const results = new Array(g.tags.length);
  let next = 0, done = 0;
  async function worker() {
    while (next < g.tags.length) {
      const i = next++;
      try { results[i] = await api(`/api/trend?${query(g.tags[i])}`); }
      catch (e) { if (e.message === 'unauthorized') return; results[i] = null; }
      done++;
      if (id === groupReq) $('ovStat').textContent = `Loading ${done} of ${g.tags.length}...`;
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  if (id !== groupReq) return;
  const withData = [], without = [];
  g.tags.forEach((t, i) => { const d = results[i]; (d && d.summary && d.summary.minutes ? withData : without).push(d && d.summary && d.summary.minutes ? d : t); });
  $('ovGrid').replaceChildren(...withData.map(ovCard));
  $('ovStat').textContent = `${withData.length} of ${g.tags.length} tags have data, ${fmtDate(Date.parse(`${state.from}:00Z`) - IST)} ${state.from.slice(11)} to ${fmtDate(Date.parse(`${state.to}:00Z`) - IST)} ${state.to.slice(11)}`;
  if (!withData.length) $('ovGrid').textContent = 'No data in this range for any tag in this group.';
  $('ovNone').hidden = !without.length;
  if (without.length) { $('ovNone').querySelector('summary').textContent = `No data / not found (${without.length})`; $('ovNone').querySelector('p').textContent = without.join(', '); }
  history.replaceState(null, '', `?${new URLSearchParams({ ...(params.get('embed') ? { embed: 1 } : {}), group: groupIdx, ...(state.tag ? { tag: state.tag } : {}), from: state.from, to: state.to })}`);
}

function refresh() { loadGroup(); if (state.tag) load(); }

function setDays(days, reload = true) {
  const t = todayStart();
  if (days === 0) { state.from = isoLocal(t); state.to = isoLocal(t + DAY); }
  else if (days === 1) { state.from = isoLocal(t - DAY); state.to = isoLocal(t); }
  else { state.from = isoLocal(t + DAY - days * DAY); state.to = isoLocal(t + DAY); }
  syncInputs();
  document.querySelectorAll('[data-days]').forEach(b => b.classList.toggle('on', Number(b.dataset.days) === days));
  if (reload) refresh();
}

function syncInputs() { $('from').value = state.from; $('to').value = state.to; }

document.querySelectorAll('[data-days]').forEach(b => b.addEventListener('click', () => setDays(Number(b.dataset.days))));
$('show').addEventListener('click', () => {
  state.from = $('from').value; state.to = $('to').value;
  document.querySelectorAll('[data-days]').forEach(b => b.classList.remove('on'));
  refresh();
});

// Tag search.
let searchTimer, matches = [], active = -1;
$('tagInput').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    const q = $('tagInput').value.trim();
    if (!q) return closeMatches();
    matches = await api(`/api/tags?q=${encodeURIComponent(q)}`);
    active = matches.length ? 0 : -1;
    drawMatches();
  }, 180);
});
$('tagInput').addEventListener('keydown', e => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (matches.length) { active = (active + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length; drawMatches(); }
  } else if (e.key === 'Enter' && matches[active]) { e.preventDefault(); pick(matches[active].tag); }
  else if (e.key === 'Escape') closeMatches();
});
$('tagInput').addEventListener('blur', () => setTimeout(closeMatches, 150));

function drawMatches() {
  const list = $('matches');
  list.replaceChildren();
  matches.forEach((m, i) => {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.textContent = m.tag;
    const span = document.createElement('span');
    span.textContent = [m.description, m.unit].filter(Boolean).join(' | ');
    li.append(span);
    if (i === active) li.className = 'active';
    li.addEventListener('mousedown', () => pick(m.tag));
    list.append(li);
  });
  list.hidden = !matches.length;
  $('tagInput').setAttribute('aria-expanded', String(!list.hidden));
}
function closeMatches() { $('matches').hidden = true; $('tagInput').setAttribute('aria-expanded', 'false'); }
function pick(tag) { document.querySelectorAll('.ocard').forEach(c => c.classList.toggle('on', c.dataset.tag === tag)); state.tag = tag; $('tagInput').value = tag; closeMatches(); load(); }

async function load() {
  if (!state.tag) return;
  const id = ++request;
  $('chartBox').style.opacity = data ? .5 : 1;
  $('message').hidden = false;
  $('message').className = 'msg';
  $('message').textContent = data ? '' : 'Loading...';
  try {
    const query = `tag=${encodeURIComponent(state.tag)}&from=${encodeURIComponent(state.from)}&to=${encodeURIComponent(state.to)}`;
    const end = Date.parse(`${state.to}:00Z`) - IST - 1;
    const dayQuery = `tag=${encodeURIComponent(state.tag)}&from=${isoDate(end - 29 * DAY)}&to=${isoDate(end)}`;
    const [trend, days] = await Promise.all([api(`/api/trend?${query}`), api(`/api/days?${dayQuery}`)]);
    if (id !== request) return;
    data = trend;
    history.replaceState(null, '', `?${new URLSearchParams({ ...(params.get('embed') ? { embed: 1 } : {}), ...(groupIdx >= 0 ? { group: groupIdx } : {}), tag: state.tag, from: state.from, to: state.to })}`);
    render(days.days);
    $('message').hidden = true;
  } catch (e) {
    if (id !== request || e.message === 'unauthorized') return;
    $('result').hidden = true;
    data = null;
    $('message').className = 'msg err';
    $('message').textContent = e.message;
  }
  $('chartBox').style.opacity = 1;
}

function tile(label, value, unit, sub) {
  const box = document.createElement('div');
  box.className = 'tile';
  const lab = document.createElement('div'); lab.className = 'lab'; lab.textContent = label;
  const val = document.createElement('div'); val.className = 'val'; val.textContent = value;
  if (unit) { const s = document.createElement('small'); s.textContent = ` ${unit}`; val.append(s); }
  const note = document.createElement('div'); note.className = 'sub'; note.textContent = sub || '';
  box.append(lab, val, note);
  return box;
}

function peak(ms, date, oneDay) {
  if (ms === undefined) return date ? fmtDate(Date.parse(date)) : '';
  const time = data.summary.source === 'tag_daily' ? fmtSec(ms) : fmtTime(ms);
  return oneDay ? `at ${time}` : `${fmtDate(ms)} ${time}`;
}

function render(days) {
  $('result').hidden = false;
  const s = data.summary, u = data.unit;
  $('tagName').textContent = data.tag;
  $('tagDesc').textContent = [data.description, u, data.type].filter(Boolean).join(' | ');
  const oneDay = data.to - data.from <= DAY;
  const tiles = [];
  const isBool = data.type === 'BOOL';
  if (s.minutes) {
    if (isBool) {
      tiles.push(tile('Time at 1', num(s.hoursAt1), 'h'), tile('Starts (0 to 1)', num(s.starts)));
    } else {
      tiles.push(
        tile('Minimum', num(s.min), u, peak(s.minAt, s.minDate, oneDay)),
        tile('Maximum', num(s.max), u, peak(s.maxAt, s.maxDate, oneDay)),
        tile('Average', num(s.avg), u),
        tile('Total', s.total === undefined ? 'n/a' : num(s.total), s.totalUnit, s.total === undefined ? 'Only for flow and power' : 'For the minutes recorded'));
    }
  }
  const whole = Math.round((data.to - data.from) / 60000);
  tiles.push(tile('Recorded', num(s.minutes), `of ${num(whole)} min`, s.minutes < whole ? `${Math.round(s.minutes / whole * 100)}% of this range` : 'Complete'));
  $('tiles').replaceChildren(...tiles);

  $('chartTitle').textContent = `${data.tag} trend, ${fmtDate(data.from)} ${fmtTime(data.from)} to ${fmtDate(data.to)} ${fmtTime(data.to)}`;
  $('chartNote').textContent = data.bucketMinutes > 1
    ? `Each point covers ${data.bucketMinutes} minutes. The line is the average and the shaded band is the min and max. Pick up to 3 days to see every minute.`
    : (s.minutes ? 'Times are India time. Gaps in the line mean the tag was not recording.' : 'No data was recorded in this range.');
  drawChart();
  drawDays(days);
  drawRows();
}

function cells(row, values) { for (const v of values) { const td = document.createElement('td'); td.textContent = v; row.append(td); } }
function head(table, names) {
  const tr = document.createElement('tr');
  for (const n of names) { const th = document.createElement('th'); th.textContent = n; tr.append(th); }
  table.tHead.replaceChildren(tr);
}

function drawDays(days) {
  const table = $('daysTable'), isBool = data.type === 'BOOL', body = table.tBodies[0];
  $('daysEmpty').hidden = days.length > 0;
  table.hidden = !days.length;
  head(table, isBool ? ['Date', 'Time at 1 (h)', 'Starts', 'Minutes'] : ['Date', 'Min', 'Min time', 'Max', 'Max time', 'Average', `Total${days[0] && days[0].totalUnit ? ` (${days[0].totalUnit})` : ''}`, 'Minutes']);
  const rows = days.map(d => {
    const tr = document.createElement('tr');
    const start = Date.parse(`${d.date}T00:00:00Z`) - IST;
    tr.tabIndex = 0;
    if (start >= data.from && start + DAY <= data.to) tr.className = 'on';
    cells(tr, isBool ? [fmtDate(start), num(d.hoursAt1), d.starts, num(d.minutes)]
      : [fmtDate(start), num(d.min), d.minAt ? fmtSec(d.minAt) : '', num(d.max), d.maxAt ? fmtSec(d.maxAt) : '', num(d.avg), d.total === undefined ? '' : num(d.total), num(d.minutes)]);
    const open = () => { state.from = isoLocal(start); state.to = isoLocal(start + DAY); syncInputs(); document.querySelectorAll('[data-days]').forEach(b => b.classList.remove('on')); load(); };
    tr.addEventListener('click', open);
    tr.addEventListener('keydown', e => { if (e.key === 'Enter') open(); });
    return tr;
  });
  body.replaceChildren(...rows);
}

function drawRows() {
  const table = $('rowsTable'), isBool = data.type === 'BOOL';
  const rows = data.points.filter(p => p.v !== undefined);
  $('rowsTitle').textContent = data.bucketMinutes > 1 ? `Values every ${data.bucketMinutes} minutes (${num(rows.length)} rows)` : `Values every minute (${num(rows.length)} rows)`;
  head(table, isBool ? ['Date', 'Time', 'Value'] : ['Date', 'Time', 'Value', 'Min', 'Max', 'Average']);
  table.tBodies[0].replaceChildren(...rows.map(p => {
    const tr = document.createElement('tr');
    cells(tr, isBool ? [fmtDate(p.t), fmtTime(p.t), p.v] : [fmtDate(p.t), fmtTime(p.t), num(p.v), num(p.min), num(p.max), num(p.avg)]);
    return tr;
  }));
}

$('csv').addEventListener('click', () => {
  if (!data) return;
  const quote = v => `"${String(v).replace(/"/g, '""')}"`;
  const lines = [['Date', 'Time', 'Value', 'Min', 'Max', 'Average'].join(',')];
  for (const p of data.points) if (p.v !== undefined) lines.push([fmtDate(p.t), fmtTime(p.t), p.v, p.min, p.max, p.avg].map(quote).join(','));
  const url = URL.createObjectURL(new Blob([lines.join('\r\n')], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${data.tag}_${isoDate(data.from)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

// Chart: one series, drawn as SVG so nothing has to be loaded from outside.
const SVG = 'http://www.w3.org/2000/svg';
const el = (name, attrs, parent) => { const n = document.createElementNS(SVG, name); for (const k in attrs) n.setAttribute(k, attrs[k]); if (parent) parent.append(n); return n; };

function niceTicks(lo, hi, count) {
  if (lo === hi) { lo -= 1; hi += 1; }
  const raw = (hi - lo) / count, mag = 10 ** Math.floor(Math.log10(raw)), norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const ticks = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) ticks.push(Math.round(v / step) * step || 0);
  return ticks;
}

function timeTicks(from, to, width) {
  const steps = [1, 2, 3, 6, 12, 24, 48, 96, 168].map(h => h * 3600000);
  const room = Math.max(3, Math.floor(width / 80));
  const step = steps.find(s => (to - from) / s <= room) || 168 * 3600000;
  const ticks = [];
  for (let t = Math.ceil((from + IST) / step) * step - IST; t <= to; t += step) ticks.push(t);
  return { ticks, step };
}

function drawChart() {
  const svg = $('chart'), box = $('chartBox'), W = box.clientWidth, H = box.clientHeight;
  svg.replaceChildren();
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const pts = data.points, known = pts.filter(p => p.v !== undefined);
  $('tip').hidden = true;
  if (!known.length) { const t = el('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', fill: 'var(--text2)' }, svg); t.textContent = 'No data recorded in this range'; return; }

  const m = { l: 58, r: 14, t: 10, b: 26 }, iw = W - m.l - m.r, ih = H - m.t - m.b;
  const isBool = data.type === 'BOOL';
  const band = data.bucketMinutes > 1 && !isBool;
  let lo = Math.min(...known.map(p => (band ? p.min : p.v))), hi = Math.max(...known.map(p => (band ? p.max : p.v)));
  if (isBool) { lo = 0; hi = 1; }
  const ticks = isBool ? [0, 1] : niceTicks(lo, hi, 5);
  const y0 = Math.min(ticks[0], lo), y1 = Math.max(ticks[ticks.length - 1], hi);
  const x = t => m.l + (t - data.from) / (data.to - data.from) * iw;
  const y = v => m.t + ih - (v - y0) / ((y1 - y0) || 1) * ih;

  for (const v of ticks) {
    el('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), stroke: 'var(--grid)' }, svg);
    const t = el('text', { x: m.l - 7, y: y(v) + 4, 'text-anchor': 'end', 'font-size': 12, fill: 'var(--text3)' }, svg);
    t.textContent = num(v);
  }
  const { ticks: xt, step } = timeTicks(data.from, data.to, iw);
  for (const t of xt) {
    el('line', { x1: x(t), x2: x(t), y1: m.t + ih, y2: m.t + ih + 4, stroke: 'var(--text3)' }, svg);
    const label = el('text', { x: x(t), y: H - 7, 'text-anchor': 'middle', 'font-size': 12, fill: 'var(--text3)' }, svg);
    label.textContent = step >= DAY ? fmtDate(t).slice(0, 5) : ((t + IST) % DAY === 0 && data.to - data.from > DAY ? fmtDate(t).slice(0, 5) : fmtTime(t));
  }
  el('line', { x1: m.l, x2: W - m.r, y1: m.t + ih, y2: m.t + ih, stroke: 'var(--text3)' }, svg);

  // A gap in the data breaks the line instead of joining across it.
  const runs = [];
  let run = null;
  for (const p of pts) {
    if (p.v === undefined) { run = null; continue; }
    if (!run) runs.push(run = []);
    run.push(p);
  }
  const value = p => (band ? p.avg : p.v);
  for (const r of runs) {
    if (band) {
      const top = r.map(p => `${x(p.t).toFixed(1)},${y(p.max).toFixed(1)}`), low = r.map(p => `${x(p.t).toFixed(1)},${y(p.min).toFixed(1)}`).reverse();
      el('polygon', { points: [...top, ...low].join(' '), fill: 'var(--band)' }, svg);
    }
    const line = [];
    r.forEach((p, i) => {
      if (isBool && i) line.push(`${x(p.t).toFixed(1)},${y(value(r[i - 1])).toFixed(1)}`);
      line.push(`${x(p.t).toFixed(1)},${y(value(p)).toFixed(1)}`);
    });
    if (r.length === 1) el('circle', { cx: x(r[0].t), cy: y(value(r[0])), r: 2.5, fill: 'var(--series)' }, svg);
    else el('polyline', { points: line.join(' '), fill: 'none', stroke: 'var(--series)', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
  }

  const hair = el('line', { y1: m.t, y2: m.t + ih, stroke: 'var(--text3)', 'stroke-dasharray': '3 3', visibility: 'hidden' }, svg);
  const dot = el('circle', { r: 4, fill: 'var(--series)', stroke: 'var(--panel)', 'stroke-width': 2, visibility: 'hidden' }, svg);
  const tip = $('tip');
  function show(i) {
    hover = Math.max(0, Math.min(pts.length - 1, i));
    const p = pts[hover], px = x(p.t);
    hair.setAttribute('x1', px); hair.setAttribute('x2', px); hair.setAttribute('visibility', 'visible');
    tip.replaceChildren();
    const when = document.createElement('div'); when.textContent = `${fmtDate(p.t)} ${fmtTime(p.t)}`;
    const big = document.createElement('b');
    big.textContent = p.v === undefined ? 'Not recording' : `${num(value(p))}${data.unit ? ` ${data.unit}` : ''}`;
    tip.append(big, when);
    if (p.v !== undefined && !isBool && (p.min !== p.max)) { const r = document.createElement('div'); r.textContent = `Min ${num(p.min)}, max ${num(p.max)}`; tip.append(r); }
    if (p.v === undefined) dot.setAttribute('visibility', 'hidden');
    else { dot.setAttribute('cx', px); dot.setAttribute('cy', y(value(p))); dot.setAttribute('visibility', 'visible'); }
    tip.hidden = false;
    tip.style.left = `${px + tip.offsetWidth + 16 > W ? px - tip.offsetWidth - 10 : px + 10}px`;
    tip.style.top = `${m.t + 4}px`;
  }
  const clear = () => { hair.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); tip.hidden = true; };
  svg.onpointermove = e => {
    const r = svg.getBoundingClientRect();
    show(Math.round((e.clientX - r.left - m.l) / iw * (pts.length - 1)));
  };
  svg.onpointerleave = clear;
  box.onkeydown = e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    show((hover === null ? 0 : hover) + (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 60 : 1));
  };
  box.onblur = clear;
}

let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (data) drawChart(); }, 120); });
start();
