'use strict';
const $ = id => document.getElementById(id);
const IST = 330 * 60000, MINUTE = 60000, HOUR = 3600000, DAY = 86400000;
const LIVE_EVERY_MS = 2000, LIVE_STALE_MS = 15000, LIVE_KEEP = 150, STATUS_EVERY_MS = 60000;
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
const parseLocal = text => Date.parse(`${text}:00Z`) - IST;
const parseStatus = text => Date.parse(`${text.replace(' ', 'T')}+05:30`);   // service_status holds India time text
const num = v => (v === null || v === undefined ? '' : Number(v).toLocaleString('en-IN', { maximumFractionDigits: 3 }));
const liveNum = v => Number(v).toLocaleString('en-IN', { minimumFractionDigits: Math.abs(v) < 1000 ? 2 : 0, maximumFractionDigits: Math.abs(v) < 1000 ? 2 : 0 });

async function api(path) {
  const res = await fetch(path, { headers: { 'x-api-key': key } });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) { showKey('That key is not right. Check it and try again.'); throw new Error('unauthorized'); }
  if (!res.ok) throw new Error(body.error || `The request failed (${res.status})`);
  return body;
}

function showKey(error) {
  clearTimeout(liveTimer);
  clearInterval(statusTimer);
  sessionStorage.removeItem('trendKey');
  key = '';
  $('app').hidden = true;
  $('gate').hidden = false;
  $('keyInput').value = '';
  $('keyError').textContent = error || '';
}

$('keyForm').addEventListener('submit', e => {
  e.preventDefault();
  key = $('keyInput').value.trim();
  sessionStorage.setItem('trendKey', key);
  start();
});
$('signOut').addEventListener('click', () => showKey());

function showTheme() { $('theme').textContent = document.documentElement.dataset.theme === 'dark' ? 'Light view' : 'Dark view'; }
$('theme').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('theme', next);
  showTheme();
});

async function start() {
  if (!key) return showKey();
  try {
    await refreshStatus();
    $('gate').hidden = true;
    $('app').hidden = false;
    showTheme();
    if (!state.from) setPreset('today', false);
    syncInputs();
    drawGroupBar();
    loadGroup();
    await pollLive();
    clearInterval(statusTimer);
    statusTimer = setInterval(() => refreshStatus().catch(() => {}), STATUS_EVERY_MS);
    if (!state.tag && liveTags.length) state.tag = liveTags[0];
    if (state.tag) { $('tagInput').value = state.tag; load(); }
    else showMessage('Search for a tag to see its values.');
  } catch (e) {
    if (e.message !== 'unauthorized') showKey(e.message);
  }
}

async function refreshStatus() {
  const status = await api('/api/status');
  const s = status[0];
  if (s && s.newestData) $('fresh').textContent = `History saved up to ${fmtTime(parseStatus(s.newestData))}, ${fmtDate(parseStatus(s.newestData))}`;
}

// Live strip. The newest reading comes from live_latest, which keeps no history, so the small
// line in each cell is drawn from the readings this page has seen since it opened.
let liveTimer, statusTimer, liveTags = [];
const liveCells = new Map();

function liveCell(item) {
  const cell = document.createElement('button');
  cell.type = 'button';
  cell.className = 'cell';
  const name = document.createElement('div'); name.className = 'name'; name.textContent = item.description || item.tag; name.title = item.tag;
  const reading = document.createElement('div'); reading.className = 'reading';
  const val = document.createElement('span'); val.className = 'val';
  const unit = document.createElement('span'); unit.className = 'unit'; unit.textContent = item.unit || '';
  reading.append(val, unit);
  const spark = el('svg', { class: 'spark', viewBox: '0 0 100 26', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
  const line = el('polyline', {}, spark);
  const meter = document.createElement('div'); meter.className = 'meter';
  const mark = document.createElement('b'); meter.append(mark);
  const range = document.createElement('div'); range.className = 'range';
  const lo = document.createElement('span'); lo.textContent = num(item.lo);
  const hi = document.createElement('span'); hi.textContent = num(item.hi);
  range.append(lo, hi);
  cell.append(name, reading, spark, meter, range);
  cell.addEventListener('click', () => { pick(item.tag); $('result').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  $('live').append(cell);
  return { cell, val, line, mark, seen: [], last: 0 };
}

function drawSpark(c) {
  const lo = Math.min(...c.seen), hi = Math.max(...c.seen), span = (hi - lo) || 1;
  const points = c.seen.map((v, i) => `${(i / (c.seen.length - 1) * 100).toFixed(2)},${(hi === lo ? 13 : 24 - (v - lo) / span * 22).toFixed(2)}`);
  c.line.setAttribute('points', c.seen.length > 1 ? points.join(' ') : '');
}

function drawLive(reply) {
  liveTags = reply.tags.map(t => t.tag);
  let newest = 0;
  for (const item of reply.tags) {
    if (!liveCells.has(item.tag)) liveCells.set(item.tag, liveCell(item));
    const c = liveCells.get(item.tag);
    c.val.textContent = liveNum(item.v);
    if (item.t !== c.last) { c.last = item.t; c.seen.push(item.v); if (c.seen.length > LIVE_KEEP) c.seen.shift(); }
    drawSpark(c);
    const share = item.hi > item.lo ? (item.v - item.lo) / (item.hi - item.lo) : 0;
    c.mark.style.left = `${Math.max(0, Math.min(1, share)) * 100}%`;
    c.cell.setAttribute('aria-pressed', String(item.tag === state.tag));
    c.cell.setAttribute('aria-label', `${item.description || item.tag}, ${liveNum(item.v)} ${item.unit || ''}. Show trend.`);
    newest = Math.max(newest, item.t);
  }
  const stale = !newest || reply.now - newest > LIVE_STALE_MS;
  $('live').classList.toggle('stale', stale);
  setPill(stale ? 'stale' : 'ok', newest ? (stale ? `Live reading stopped at ${fmtSec(newest)}` : `Live, read at ${fmtSec(newest)}`) : 'No live readings yet');
  $('liveNote').hidden = !stale || !newest;
  if (stale && newest) $('liveNote').textContent = `These are the last values received, on ${fmtDate(newest)} at ${fmtSec(newest)}. History below is not affected.`;
}

function setPill(kind, text) {
  $('pill').className = `pill ${kind}`;
  $('pillText').textContent = text;
}

async function pollLive() {
  clearTimeout(liveTimer);
  try {
    drawLive(await api('/api/live'));
  } catch (e) {
    if (e.message === 'unauthorized') throw e;
    setPill('lost', 'Connection lost, retrying');
  }
  if (!document.hidden) liveTimer = setTimeout(() => pollLive().catch(() => {}), LIVE_EVERY_MS);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && key && !$('app').hidden) pollLive().catch(() => {}); });

// Tag groups shown as an overview. Only tags that have data in the chosen period are drawn.
const GROUPS = [
  { name: 'Vibration, displacement and bearing temperature', tags: `ZIA_201A.PV ZIA_201B.PV ZIA_202.PV VIA_201A.PV VIA_201B.PV VIB_202A.PV VIB_202B.PV VIB_203A.PV VIB_203B.PV VIB_204A.PV VIB_204B.PV VI_205A.PV VI_205B.PV VI_206A.PV VI_206B.PV VI_251A.PV VI_251B.PV VI_252A.PV VI_252B.PV TE_201.PV TE_202.PV TE_203.PV TE_204.PV TE_205.PV TE_206.PV TE_207.PV TE_208.PV GEN_DE GEN_NDE`.split(' ') },
  { name: 'Process (load, pressure, temperature, flow, level)', tags: `TG_LOAD.PV PT_02.PV TT_07ABC FT_02_COMP LT_01_FINAL FW_FLOW_TOT PT100_FINAL FT200_FINAL FT_201.PV PT_01.PV ZT_S01 PT_26.PV TE_100_1.PV TE_01.PV TE_02.PV TE_10.PV TT_03.PV TT_04.PV TT_05.PV TE_13.PV TE_26.PV TE_200.PV TE_201.PV DT_200.PV DT_201.PV DT_203.PV PT_100A.PV PT_100B.PV DT_101.PV DT_109.PV DT_102.PV DT_103.PV DT_104.PV TE_102.PV TE_105.PV TE_106.PV TE_107.PV AT_100.PV LT_51AVG LT_53.PV TE_104.PV FT_03.PV BAG_FLOW_TOTAL`.split(' ') }
];
const GROUP_WORKERS = 6;
let groupIdx = Number(params.get('group') || -1), groupReq = 0;

function drawGroupBar() {
  $('groupBar').replaceChildren(...GROUPS.map((g, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = `${g.name} (${g.tags.length})`;
    b.classList.toggle('on', i === groupIdx);
    b.setAttribute('aria-pressed', String(i === groupIdx));
    b.addEventListener('click', () => { groupIdx = i === groupIdx ? -1 : i; drawGroupBar(); loadGroup(); saveUrl(); });
    return b;
  }));
}

function groupSpark(d) {
  const W = 200, H = 34, known = d.points.filter(p => p.v !== undefined);
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' });
  if (known.length < 2) return svg;
  const vs = known.map(p => p.v), lo = Math.min(...vs), hi = Math.max(...vs);
  const x = t => (t - d.from) / (d.to - d.from) * W, y = v => H - 3 - (v - lo) / ((hi - lo) || 1) * (H - 6);
  let run = [];
  const flush = () => { if (run.length > 1) el('polyline', { points: run.join(' ') }, svg); run = []; };
  for (const p of d.points) { if (p.v === undefined) flush(); else run.push(`${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`); }
  flush();
  return svg;
}

function groupCard(d) {
  const last = [...d.points].reverse().find(p => p.v !== undefined);
  const possible = Math.round((Math.min(d.to, Date.now()) - d.from) / MINUTE);
  const c = document.createElement('button');
  c.type = 'button'; c.className = 'ocard'; c.dataset.tag = d.tag;
  c.classList.toggle('on', d.tag === state.tag);
  const name = document.createElement('div'); name.className = 'ds'; name.textContent = d.description || d.tag; name.title = d.tag;
  const code = document.createElement('div'); code.className = 'nm'; code.textContent = d.tag;
  const value = document.createElement('div'); value.className = 'vl'; value.textContent = num(last.v);
  if (d.unit) { const u = document.createElement('small'); u.textContent = ` ${d.unit}`; value.append(u); }
  const seen = document.createElement('div'); seen.className = 'nm';
  seen.textContent = `Latest saved value, recorded ${Math.min(100, Math.round(d.summary.minutes / possible * 100))}%`;
  c.append(name, code, value, groupSpark(d), seen);
  c.addEventListener('click', () => { pick(d.tag); $('result').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  return c;
}

async function loadGroup() {
  if (groupIdx < 0 || !GROUPS[groupIdx]) { $('overview').hidden = true; return; }
  const g = GROUPS[groupIdx], id = ++groupReq;
  $('overview').hidden = false;
  $('ovTitle').textContent = g.name;
  $('ovStat').textContent = 'Loading the group.';
  $('ovGrid').replaceChildren();
  $('ovGrid').hidden = true;
  $('ovNone').hidden = true;
  $('ovError').hidden = true;
  const query = tag => `tag=${encodeURIComponent(tag)}&from=${encodeURIComponent(state.from)}&to=${encodeURIComponent(state.to)}`;
  const results = new Array(g.tags.length), failures = [];
  let next = 0, done = 0;
  async function worker() {
    while (next < g.tags.length) {
      const i = next++;
      try { results[i] = await api(`/api/trend?${query(g.tags[i])}`); }
      catch (e) {
        if (e.message === 'unauthorized') return;
        results[i] = null;
        if (!/was not found|on\/off tag/.test(e.message)) failures.push(`${g.tags[i]}: ${e.message}`);
      }
      done++;
      if (id === groupReq) $('ovStat').textContent = `Loading ${done} of ${g.tags.length} tags.`;
    }
  }
  await Promise.all(Array.from({ length: GROUP_WORKERS }, worker));
  if (id !== groupReq) return;
  const withData = [], without = [];
  g.tags.forEach((t, i) => { const d = results[i]; if (d && d.summary.minutes) withData.push(d); else without.push(t); });
  $('ovGrid').replaceChildren(...withData.map(groupCard));
  $('ovGrid').hidden = !withData.length;
  $('ovStat').textContent = `${withData.length} of ${g.tags.length} tags have data in this period`;
  $('ovNone').hidden = !without.length;
  $('ovNone').querySelector('summary').textContent = `No data in this period (${without.length})`;
  $('ovNone').querySelector('p').textContent = without.join(', ');
  $('ovError').hidden = !failures.length;
  $('ovError').textContent = failures.length ? `${failures.length} tags could not be read from the database: ${failures.join('; ')}` : '';
}

function saveUrl() {
  history.replaceState(null, '', `?${new URLSearchParams({ ...(params.get('embed') ? { embed: 1 } : {}), ...(groupIdx >= 0 ? { group: groupIdx } : {}), ...(state.tag ? { tag: state.tag } : {}), from: state.from, to: state.to })}`);
}

function refresh() { loadGroup(); load(); }

// Period.
function setPreset(name, reload = true) {
  const now = Math.floor(Date.now() / MINUTE) * MINUTE, t = todayStart();
  const ranges = { '1h': [now - HOUR, now], '8h': [now - 8 * HOUR, now], today: [t, now], yesterday: [t - DAY, t], '7d': [t - 6 * DAY, now], '30d': [t - 29 * DAY, now] };
  const [from, to] = ranges[name];
  state.from = isoLocal(from);
  state.to = isoLocal(to);
  syncInputs();
  markPreset(name);
  if (reload) refresh();
}
function markPreset(name) { document.querySelectorAll('[data-preset]').forEach(b => b.classList.toggle('on', b.dataset.preset === name)); }
function syncInputs() { $('from').value = state.from; $('to').value = state.to; }

document.querySelectorAll('[data-preset]').forEach(b => b.addEventListener('click', () => setPreset(b.dataset.preset)));
$('show').addEventListener('click', () => {
  state.from = $('from').value; state.to = $('to').value;
  markPreset('');
  refresh();
});

// Tag search.
let searchTimer, matches = [], active = -1;
async function findTags() {
  matches = await api(`/api/tags?q=${encodeURIComponent($('tagInput').value.trim())}`);
  active = matches.length ? 0 : -1;
  drawMatches();
}
$('tagInput').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => findTags().catch(() => {}), 180); });
$('tagInput').addEventListener('focus', () => { $('tagInput').select(); });
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
    span.textContent = [m.description, m.unit].filter(Boolean).join(', ');
    li.append(span);
    if (i === active) li.className = 'active';
    li.addEventListener('mousedown', () => pick(m.tag));
    list.append(li);
  });
  list.hidden = !matches.length;
  $('tagInput').setAttribute('aria-expanded', String(!list.hidden));
}
function closeMatches() { $('matches').hidden = true; $('tagInput').setAttribute('aria-expanded', 'false'); }
function pick(tag) {
  state.tag = tag;
  $('tagInput').value = tag;
  closeMatches();
  liveCells.forEach((c, name) => c.cell.setAttribute('aria-pressed', String(name === tag)));
  document.querySelectorAll('.ocard').forEach(c => c.classList.toggle('on', c.dataset.tag === tag));
  load();
}

function showMessage(text, isError) {
  $('message').hidden = false;
  $('message').className = isError ? 'msg err' : 'msg';
  $('message').textContent = text;
}

async function load() {
  if (!state.tag) return;
  const id = ++request;
  $('chartBox').style.opacity = data ? .5 : 1;
  if (!data) showMessage('Loading the period.');
  try {
    const query = `tag=${encodeURIComponent(state.tag)}&from=${encodeURIComponent(state.from)}&to=${encodeURIComponent(state.to)}`;
    const end = parseLocal(state.to) - 1;
    const dayQuery = `tag=${encodeURIComponent(state.tag)}&from=${isoDate(end - 29 * DAY)}&to=${isoDate(end)}`;
    const [trend, days] = await Promise.all([api(`/api/trend?${query}`), api(`/api/days?${dayQuery}`)]);
    if (id !== request) return;
    data = trend;
    saveUrl();
    render(days.days);
    $('message').hidden = true;
  } catch (e) {
    if (id !== request || e.message === 'unauthorized') return;
    $('result').hidden = true;
    data = null;
    showMessage(e.message, true);
  }
  $('chartBox').style.opacity = 1;
}

function figure(label, value, unit, sub, lead) {
  const box = document.createElement('div');
  box.className = lead ? 'fig lead' : 'fig';
  const lab = document.createElement('div'); lab.className = 'lab'; lab.textContent = label;
  const val = document.createElement('div'); val.className = 'val'; val.textContent = value;
  if (unit) { const s = document.createElement('small'); s.textContent = ` ${unit}`; val.append(s); }
  const note = document.createElement('div'); note.className = 'sub'; note.textContent = sub || '';
  box.append(lab, val, note);
  return box;
}

const when = (ms, oneDay) => (oneDay ? `at ${fmtTime(ms)}` : `${fmtDate(ms)} ${fmtTime(ms)}`);

function render(days) {
  $('result').hidden = false;
  const s = data.summary, u = data.unit;
  $('tagName').textContent = data.description || data.tag;
  $('tagCode').textContent = data.tag;
  const oneDay = data.to - data.from <= DAY;
  const span = isoDate(data.from) === isoDate(data.to - 1)
    ? `${fmtDate(data.from)}, ${fmtTime(data.from)} to ${fmtTime(data.to)}`
    : `${fmtDate(data.from)} ${fmtTime(data.from)} to ${fmtDate(data.to)} ${fmtTime(data.to)}`;
  $('period').textContent = `${span}, India time`;

  // Minutes that have not happened yet are not missing, so they do not count against the period.
  const possible = Math.round((Math.min(data.to, Date.now()) - data.from) / MINUTE);
  const share = possible > 0 ? Math.min(100, Math.round(s.minutes / possible * 100)) : 0;
  const figs = [];
  if (s.minutes) {
    figs.push(
      figure('Average', num(s.avg), u, `Over ${num(s.minutes)} recorded minutes`, true),
      s.total === undefined
        ? figure('Total', 'n/a', '', 'Only flow and power tags have a total', true)
        : figure('Total', num(s.total), s.totalUnit, `Over ${num(s.minutes)} recorded minutes`, true),
      figure('Minimum', num(s.min), u, when(s.minAt, oneDay)),
      figure('Maximum', num(s.max), u, when(s.maxAt, oneDay)));
  } else {
    figs.push(figure('Average', 'n/a', '', 'Nothing recorded in this period', true), figure('Total', 'n/a', '', 'Nothing recorded in this period', true), figure('Minimum', 'n/a'), figure('Maximum', 'n/a'));
  }
  figs.push(figure('Recorded', `${share}%`, '', `${num(s.minutes)} of ${num(possible)} minutes`));
  $('figures').replaceChildren(...figs);

  $('chartNote').textContent = data.bucketMinutes > 1
    ? `Each point covers ${data.bucketMinutes} minutes: the line is the average and the shaded band is the minimum and maximum. Choose up to 3 days to see every minute.`
    : (s.minutes ? 'Gaps in the line mean nothing was recorded. History arrives about every 10 minutes.' : 'Choose another period, or check that this tag was recording.');
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
  const table = $('daysTable'), hasTotal = days.some(d => d.total !== undefined);
  $('daysEmpty').hidden = days.length > 0;
  table.hidden = !days.length;
  const unit = data.unit ? ` (${data.unit})` : '';
  head(table, ['Date', `Average${unit}`, ...(hasTotal ? [`Total (${days.find(d => d.totalUnit).totalUnit})`] : []), 'Minimum', 'At', 'Maximum', 'At', 'Minutes']);
  table.tBodies[0].replaceChildren(...days.map(d => {
    const tr = document.createElement('tr');
    const start = Date.parse(`${d.date}T00:00:00Z`) - IST;
    tr.tabIndex = 0;
    if (start >= data.from && start + DAY <= data.to) tr.className = 'on';
    cells(tr, [fmtDate(start), num(d.avg), ...(hasTotal ? [num(d.total)] : []), num(d.min), fmtTime(d.minAt), num(d.max), fmtTime(d.maxAt), num(d.minutes)]);
    const open = () => { state.from = isoLocal(start); state.to = isoLocal(start + DAY); syncInputs(); markPreset(''); load(); };
    tr.addEventListener('click', open);
    tr.addEventListener('keydown', e => { if (e.key === 'Enter') open(); });
    return tr;
  }));
}

function drawRows() {
  const table = $('rowsTable'), band = data.bucketMinutes > 1;
  const rows = data.points.filter(p => p.v !== undefined);
  head(table, band ? ['Date', 'Time', 'Last value', 'Minimum', 'Maximum', 'Average'] : ['Date', 'Time', 'Value']);
  table.tBodies[0].replaceChildren(...rows.map(p => {
    const tr = document.createElement('tr');
    cells(tr, band ? [fmtDate(p.t), fmtTime(p.t), num(p.v), num(p.min), num(p.max), num(p.avg)] : [fmtDate(p.t), fmtTime(p.t), num(p.v)]);
    return tr;
  }));
}

function showTab(days) {
  $('tabDays').setAttribute('aria-selected', String(days));
  $('tabRows').setAttribute('aria-selected', String(!days));
  $('paneDays').hidden = !days;
  $('paneRows').hidden = days;
}
$('tabDays').addEventListener('click', () => showTab(true));
$('tabRows').addEventListener('click', () => showTab(false));

$('csv').addEventListener('click', () => {
  if (!data) return;
  const band = data.bucketMinutes > 1;
  const quote = v => `"${String(v).replace(/"/g, '""')}"`;
  const lines = [(band ? ['Date', 'Time', 'Last value', 'Minimum', 'Maximum', 'Average'] : ['Date', 'Time', 'Value']).join(',')];
  for (const p of data.points) if (p.v !== undefined) lines.push((band ? [fmtDate(p.t), fmtTime(p.t), p.v, p.min, p.max, p.avg] : [fmtDate(p.t), fmtTime(p.t), p.v]).map(quote).join(','));
  const url = URL.createObjectURL(new Blob([lines.join('\r\n')], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${data.tag}_${isoDate(data.from)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

// Chart: one series, drawn as SVG so nothing has to be loaded from outside.
function el(name, attrs, parent) {
  const n = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (parent) parent.append(n);
  return n;
}

function niceTicks(lo, hi, count) {
  if (lo === hi) { lo -= 1; hi += 1; }
  const raw = (hi - lo) / count, mag = 10 ** Math.floor(Math.log10(raw)), norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const ticks = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) ticks.push(Math.round(v / step) * step || 0);
  return ticks;
}

function timeTicks(from, to, width) {
  const steps = [.25, .5, 1, 2, 3, 6, 12, 24, 48, 96, 168].map(h => h * HOUR);
  const room = Math.max(3, Math.floor(width / 80));
  const step = steps.find(s => (to - from) / s <= room) || 168 * HOUR;
  const ticks = [];
  for (let t = Math.ceil((from + IST) / step) * step - IST; t <= to; t += step) ticks.push(t);
  return { ticks, step };
}

function drawChart() {
  const svg = $('chart'), box = $('chartBox'), W = box.clientWidth, H = box.clientHeight;
  svg.replaceChildren();
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.onpointermove = svg.onpointerleave = box.onkeydown = box.onblur = null;
  const pts = data.points, known = pts.filter(p => p.v !== undefined);
  $('tip').hidden = true;
  if (!known.length) { const t = el('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', fill: 'var(--ink2)' }, svg); t.textContent = 'Nothing was recorded in this period'; return; }

  const m = { l: 62, r: 14, t: 10, b: 26 }, iw = W - m.l - m.r, ih = H - m.t - m.b;
  const band = data.bucketMinutes > 1;
  const lo = Math.min(...known.map(p => (band ? p.min : p.v))), hi = Math.max(...known.map(p => (band ? p.max : p.v)));
  const ticks = niceTicks(lo, hi, 5);
  const y0 = Math.min(ticks[0], lo), y1 = Math.max(ticks[ticks.length - 1], hi);
  const x = t => m.l + (t - data.from) / (data.to - data.from) * iw;
  const y = v => m.t + ih - (v - y0) / ((y1 - y0) || 1) * ih;

  for (const v of ticks) {
    el('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), stroke: 'var(--grid)' }, svg);
    const t = el('text', { x: m.l - 8, y: y(v) + 4, 'text-anchor': 'end', 'font-size': 12.5, fill: 'var(--ink3)' }, svg);
    t.textContent = num(v);
  }
  const { ticks: xt, step } = timeTicks(data.from, data.to, iw);
  for (const t of xt) {
    el('line', { x1: x(t), x2: x(t), y1: m.t + ih, y2: m.t + ih + 4, stroke: 'var(--axis)' }, svg);
    const label = el('text', { x: x(t), y: H - 7, 'text-anchor': 'middle', 'font-size': 12.5, fill: 'var(--ink3)' }, svg);
    label.textContent = step >= DAY ? fmtDate(t).slice(0, 5) : ((t + IST) % DAY === 0 && data.to - data.from > DAY ? fmtDate(t).slice(0, 5) : fmtTime(t));
  }
  el('line', { x1: m.l, x2: W - m.r, y1: m.t + ih, y2: m.t + ih, stroke: 'var(--axis)' }, svg);

  // A gap in the data breaks the line instead of joining across it.
  const runs = [];
  let run = null;
  for (const p of pts) {
    if (p.v === undefined) { run = null; continue; }
    if (!run) runs.push(run = []);
    run.push(p);
  }
  const value = p => (band ? p.avg : p.v);
  const at = (p, v) => `${x(p.t).toFixed(1)},${y(v).toFixed(1)}`;
  const base = y(Math.max(y0, Math.min(0, y1))).toFixed(1);   // the wash reaches zero, or the axis if zero is off the chart
  for (const r of runs) {
    if (band) el('polygon', { points: [...r.map(p => at(p, p.max)), ...r.map(p => at(p, p.min)).reverse()].join(' '), fill: 'var(--band)' }, svg);
    else if (r.length > 1) el('polygon', { points: [`${x(r[0].t).toFixed(1)},${base}`, ...r.map(p => at(p, p.v)), `${x(r[r.length - 1].t).toFixed(1)},${base}`].join(' '), fill: 'var(--wash)' }, svg);
    if (r.length === 1) el('circle', { cx: x(r[0].t), cy: y(value(r[0])), r: 4, fill: 'var(--series)' }, svg);
    else el('polyline', { points: r.map(p => at(p, value(p))).join(' '), fill: 'none', stroke: 'var(--series)', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
  }

  const hair = el('line', { y1: m.t, y2: m.t + ih, stroke: 'var(--ink3)', visibility: 'hidden' }, svg);
  const dot = el('circle', { r: 4, fill: 'var(--series)', stroke: 'var(--surface)', 'stroke-width': 2, visibility: 'hidden' }, svg);
  const tip = $('tip');
  function show(i) {
    hover = Math.max(0, Math.min(pts.length - 1, i));
    const p = pts[hover], px = x(p.t);
    hair.setAttribute('x1', px); hair.setAttribute('x2', px); hair.setAttribute('visibility', 'visible');
    tip.replaceChildren();
    const big = document.createElement('b');
    big.textContent = p.v === undefined ? 'Not recorded' : `${num(value(p))}${data.unit ? ` ${data.unit}` : ''}`;
    const time = document.createElement('div'); time.textContent = `${fmtDate(p.t)} ${fmtTime(p.t)}`;
    tip.append(big, time);
    if (band && p.v !== undefined) { const r = document.createElement('div'); r.textContent = `Minimum ${num(p.min)}, maximum ${num(p.max)}`; tip.append(r); }
    if (p.v === undefined) dot.setAttribute('visibility', 'hidden');
    else { dot.setAttribute('cx', px); dot.setAttribute('cy', y(value(p))); dot.setAttribute('visibility', 'visible'); }
    tip.hidden = false;
    tip.style.left = `${px + tip.offsetWidth + 16 > W ? Math.max(0, px - tip.offsetWidth - 10) : px + 10}px`;
    tip.style.top = `${m.t + 4}px`;
  }
  const clear = () => { hair.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); tip.hidden = true; };
  svg.onpointermove = e => {
    const r = svg.getBoundingClientRect(), t = data.from + (e.clientX - r.left - m.l) / iw * (data.to - data.from);
    show(Math.round((t - data.from) / (data.bucketMinutes * MINUTE)));
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
