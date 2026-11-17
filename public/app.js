'use strict';
const $ = id => document.getElementById(id);
const IST = 330 * 60000, MINUTE = 60000, HOUR = 3600000, DAY = 86400000;
const LIVE_EVERY_MS = 2000, LIVE_STALE_MS = 15000, LIVE_KEEP = 150, STATUS_EVERY_MS = 60000;
// GitHub Pages serves only these files, so there the data comes from the server on Render.
const API = location.hostname.endsWith('.github.io') ? 'https://dcs-trendweb.onrender.com' : '';
const params = new URLSearchParams(location.search);
if (params.get('embed') === '1') document.body.classList.add('embed');

let key = sessionStorage.getItem('trendKey') || '';
if (location.hash.startsWith('#key=')) {
  key = decodeURIComponent(location.hash.slice(5));
  sessionStorage.setItem('trendKey', key);
  history.replaceState(null, '', location.pathname + location.search);
}

let state = { tag: params.get('tag') || '', from: params.get('from') || '', to: params.get('to') || '' };
let data = null, hover = null, request = 0, rowsShown = null;

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
  const res = await fetch(API + path, { headers: { 'x-api-key': key } });
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

function showTheme() { $('themeText').textContent =document.documentElement.dataset.theme === 'dark' ? 'Light view' : 'Dark view'; }
$('theme').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('theme', next);
  showTheme();
});

async function start() {
  if (!key) return showKey();
  // The page opens at once and each part fills in as its data arrives. A wrong key returns to the gate.
  $('gate').hidden = true;
  $('app').hidden = false;
  showTheme();
  if (!state.from) setPreset('today', false);
  syncInputs();
  clearInterval(statusTimer);
  statusTimer = setInterval(() => refreshStatus().catch(() => {}), STATUS_EVERY_MS);
  refreshStatus().catch(() => {});
  if (state.tag) { $('tagInput').value = state.tag; load(); }
  try { await pollLive(); } catch (e) { return; }
  if (state.tag) return;
  if (!liveTags.length) return showMessage('Search for a tag to see its values.');
  state.tag = liveTags[0];
  $('tagInput').value = state.tag;
  liveCells.get(state.tag).cell.setAttribute('aria-pressed', 'true');
  load();
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
const liveNow = new Map();   // newest reading of each live tag, also read by enthalpy.js

// Each tag gets a round badge with its first letters, tinted by a colour worked out from its name.
const initials = tag => tag.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase();
const hueOf = tag => { let h = 0; for (const ch of tag) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; };
function paintAvatar(node, tag) { node.textContent = initials(tag); node.style.setProperty('--h', hueOf(tag)); }

// Shows a change as "+1.25 (0.84%)" in green, red or grey.
function setChange(node, delta, base, format) {
  if (delta === null || !Number.isFinite(delta)) { node.textContent = '—'; node.className = 'chg flat'; return 'flat'; }
  const dir = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
  const pct = base ? ` (${Math.abs(delta / base * 100).toFixed(2)}%)` : '';
  node.textContent = `${delta > 0 ? '+' : delta < 0 ? '−' : ''}${format(Math.abs(delta))}${pct}`;
  node.className = `chg ${dir}`;
  return dir;
}

function liveCell(item) {
  const cell = document.createElement('button');
  cell.type = 'button';
  cell.className = 'cell';
  const top = document.createElement('div'); top.className = 'top';
  const av = document.createElement('span'); av.className = 'av'; av.setAttribute('aria-hidden', 'true'); paintAvatar(av, item.tag);
  const name = document.createElement('div'); name.className = 'name'; name.textContent = item.description || item.tag; name.title = item.tag;
  top.append(av, name);
  const reading = document.createElement('div'); reading.className = 'reading';
  const val = document.createElement('span'); val.className = 'val';
  const unit = document.createElement('span'); unit.className = 'unit'; unit.textContent = item.unit || '';
  reading.append(val, unit);
  const note = document.createElement('div'); note.className = 'cell-note'; note.hidden = true;
  const lim = document.createElement('div'); lim.className = 'lim'; lim.hidden = true;
  const foot = document.createElement('div'); foot.className = 'foot';
  const chg = document.createElement('span'); chg.className = 'chg flat'; chg.title = 'Change since this page started reading';
  const spark = el('svg', { class: 'spark', viewBox: '0 0 100 26', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
  const line = el('polyline', {}, spark);
  foot.append(chg, spark);
  cell.append(top, reading, note, lim, foot);
  cell.addEventListener('click', () => { pick(item.tag); $('result').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  // The saved steam rate leads the list; the card worked out in the browser is then no longer needed.
  if (item.tag === STEAM_TAG) {
    cell.classList.add('featured'); $('live').prepend(cell);
    if ($('steamCard')) $('steamCard').remove();
  } else if (item.tag === ENTHALPY_TAG) {
    // Enthalpy sits right after the steam rate (or first until the steam rate arrives).
    cell.classList.add('featured');
    const steam = liveCells.get(STEAM_TAG);
    if (steam) steam.cell.after(cell); else $('live').prepend(cell);
  } else $('live').append(cell);
  return { cell, val, line, chg, lim, note, seen: [], last: 0 };
}

// Limits each viewer sets on live values. They are kept in this browser only, so everyone can have their own.
// A value past its limit turns the card red; within the limit it is green.
const LIMIT_KEY = 'liveLimits';
let limits = {};
try { limits = JSON.parse(localStorage.getItem(LIMIT_KEY)) || {}; } catch (e) { limits = {}; }

function applyLimit(c, item) {
  const lim = limits[item.tag], has = !!lim && Number.isFinite(lim.value);
  c.cell.classList.toggle('limited', has);
  c.lim.hidden = !has;
  if (!has) { c.cell.classList.remove('over', 'under'); return; }
  const below = lim.dir === 'below', out = below ? item.v < lim.value : item.v > lim.value;
  c.cell.classList.toggle('over', out);
  c.cell.classList.toggle('under', !out);
  c.lim.textContent = `${out ? (below ? 'Below' : 'Above') + ' limit' : 'Within limit'} · ${below ? 'min' : 'max'} ${num(lim.value)}`;
}

function openLimits() {
  const rows = [...liveNow.values()].map(item => {
    const lim = limits[item.tag] || {};
    const row = document.createElement('div'); row.className = 'lim-row'; row.dataset.tag = item.tag;
    const name = document.createElement('div'); name.className = 'lim-name';
    const title = document.createElement('b'); title.textContent = item.description || item.tag;
    const code = document.createElement('span'); code.textContent = `${item.tag} · now ${liveNum(item.v)} ${item.unit || ''}`;
    name.append(title, code);
    const dir = document.createElement('select'); dir.setAttribute('aria-label', `Alarm side for ${item.tag}`);
    for (const [v, t] of [['above', 'Red above'], ['below', 'Red below']]) { const o = document.createElement('option'); o.value = v; o.textContent = t; dir.append(o); }
    dir.value = lim.dir || 'above';
    const input = document.createElement('input'); input.type = 'number'; input.step = 'any'; input.inputMode = 'decimal';
    input.placeholder = 'No limit'; input.setAttribute('aria-label', `Limit for ${item.tag}`);
    if (Number.isFinite(lim.value)) input.value = lim.value;
    row.append(name, dir, input);
    return row;
  });
  $('limList').replaceChildren(...rows);
  $('limEmpty').hidden = rows.length > 0;
}

function saveLimits() {
  for (const row of $('limList').children) {
    const value = row.querySelector('input').value.trim();
    if (value === '' || !Number.isFinite(Number(value))) delete limits[row.dataset.tag];
    else limits[row.dataset.tag] = { value: Number(value), dir: row.querySelector('select').value };
  }
  try { localStorage.setItem(LIMIT_KEY, JSON.stringify(limits)); } catch (e) { /* kept for this visit only */ }
  liveCells.forEach((c, tag) => { const item = liveNow.get(tag); if (item) applyLimit(c, item); });
  location.hash = '#/';   // back to the dashboard to see the colours
}

// The limits page (#/limits) is opened from the menu; tools.js calls openLimits when it is shown.
$('limSave').addEventListener('click', saveLimits);
$('limCancel').addEventListener('click', () => { location.hash = '#/'; });
$('limClear').addEventListener('click', () => { for (const input of $('limList').querySelectorAll('input')) input.value = ''; });

function drawSpark(c) {
  const lo = Math.min(...c.seen), hi = Math.max(...c.seen), span = (hi - lo) || 1;
  const points = c.seen.map((v, i) => `${(i / (c.seen.length - 1) * 100).toFixed(2)},${(hi === lo ? 13 : 24 - (v - lo) / span * 22).toFixed(2)}`);
  c.line.setAttribute('points', c.seen.length > 1 ? points.join(' ') : '');
}

// SteamRate.exe saves FT_02A.PV / TG_LOAD.PV as this tag. Until it appears, the page works it out itself.
const STEAM_TAG = 'STEAM_RATE.PV';
function drawSteamRate(tags) {
  if (!$('steamCard')) return;
  const flow = tags.find(item => item.tag === 'FT_02A.PV');
  const load = tags.find(item => item.tag === 'TG_LOAD.PV');
  const valueOf = item => item && item.v !== null && item.v !== undefined && Number.isFinite(Number(item.v)) ? Number(item.v) : null;
  const flowValue = valueOf(flow);
  const loadValue = valueOf(load);
  if (flowValue === null || loadValue === null) {
    $('steamRate').textContent = '--';
    $('steamFormula').textContent = 'Waiting for valid Steam flow and TG Load readings.';
  } else if (loadValue === 0) {
    $('steamRate').textContent = '--';
    $('steamFormula').textContent = 'TG Load is 0 MW; Steam Rate cannot be calculated.';
  } else {
    $('steamRate').textContent = liveNum(flowValue / loadValue);
    $('steamFormula').textContent = `${liveNum(flowValue)} TPH ÷ ${liveNum(loadValue)} MW`;
  }
}

// Live main steam enthalpy, worked out here every reading from PT_02.PV and TT_07A.PV with IAPWS-IF97,
// so it shows even when SteamRate.exe is not running. It replaces the saved H_MS.PV card; clicking it
// opens the saved H_MS.PV history.
const ENTHALPY_TAG = 'H_MS.PV';
const oneDp = v => Number(v).toLocaleString('en-IN', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
function liveEnthalpy(tags) {
  const p = tags.find(x => x.tag === 'PT_02.PV'), t = tags.find(x => x.tag === 'TT_07A.PV');
  if (!p || !t || !window.IF97 || !Number.isFinite(p.v) || !Number.isFinite(t.v)) return null;
  const st = IF97.fromPlant(p.v, t.v);
  if (st.superheatC <= 0) return null;   // not superheated: the formula does not apply
  return {
    tag: ENTHALPY_TAG, description: 'Live main steam enthalpy', unit: 'kJ/kg', t: Math.max(p.t, t.t), v: Math.round(st.h * 10) / 10, digits: 1,
    note: `= ${oneDp(st.hKcal)} kcal/kg · ${oneDp(st.superheatC)} °C superheat${st.inRange ? '' : ' · outside checked range'}`
  };
}

function drawLive(reply) {
  const h = liveEnthalpy(reply.tags);
  const tags = reply.tags.filter(x => x.tag !== ENTHALPY_TAG).concat(h ? [h] : []);
  liveTags = tags.map(t => t.tag);
  let newest = 0;
  for (const item of tags) {
    liveNow.set(item.tag, item);
    if (!liveCells.has(item.tag)) liveCells.set(item.tag, liveCell(item));
    const c = liveCells.get(item.tag);
    c.val.textContent = item.digits === undefined ? liveNum(item.v) : oneDp(item.v);
    if (item.t !== c.last) { c.last = item.t; c.seen.push(item.v); if (c.seen.length > LIVE_KEEP) c.seen.shift(); }
    drawSpark(c);
    c.cell.dataset.dir = setChange(c.chg, c.seen.length > 1 ? item.v - c.seen[0] : null, c.seen[0], liveNum);
    applyLimit(c, item);
    c.note.hidden = !item.note;
    if (item.note) c.note.textContent = item.note;
    c.cell.setAttribute('aria-pressed', String(item.tag === state.tag));
    c.cell.setAttribute('aria-label', `${item.description || item.tag}, ${liveNum(item.v)} ${item.unit || ''}. Show trend.`);
    newest = Math.max(newest, item.t);
  }
  drawSteamRate(reply.tags);
  if (window.onLiveReading) window.onLiveReading();
  if (!$('viewLimits').hidden && !$('limList').children.length) openLimits();   // limits page opened before live values came
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

// Period.
function setPreset(name, reload = true) {
  const now = Math.floor(Date.now() / MINUTE) * MINUTE, t = todayStart();
  const ranges = { '1h': [now - HOUR, now], '8h': [now - 8 * HOUR, now], today: [t, now], yesterday: [t - DAY, t], '7d': [t - 6 * DAY, now], '30d': [t - 29 * DAY, now] };
  const [from, to] = ranges[name];
  state.from = isoLocal(from);
  state.to = isoLocal(to);
  syncInputs();
  markPreset(name);
  if (reload) load();
}
// On a phone the search box sits under the live values; on wider screens it is in the top bar.
const searchBox = document.querySelector('.search'), searchHome = searchBox.parentNode, searchAfter = searchBox.nextElementSibling;
const phone = matchMedia('(max-width: 760px)');
function placeSearch() { if (phone.matches) $('mobileSearch').append(searchBox); else searchHome.insertBefore(searchBox, searchAfter); }
phone.addEventListener('change', placeSearch);
placeSearch();

// A period chosen by date (Custom, or a click in the daily table) marks the Custom chip instead.
function markPreset(name) {
  document.querySelectorAll('[data-preset]').forEach(b => b.classList.toggle('on', b.dataset.preset === name));
  $('customBtn').classList.toggle('on', !name);
}
function syncInputs() { $('from').value = state.from; $('to').value = state.to; }
function showCustom(open) { $('custom').hidden = !open; $('customBtn').setAttribute('aria-expanded', String(open)); }

document.querySelectorAll('[data-preset]').forEach(b => b.addEventListener('click', () => { showCustom(false); setPreset(b.dataset.preset); }));
$('customBtn').addEventListener('click', () => { showCustom($('custom').hidden); if (!$('custom').hidden) $('from').focus(); });
$('askAi').addEventListener('click', () => {
  if ($('aiPanel').hidden) $('aiToggle').click();
  if (data && !$('aiInput').value) $('aiInput').value = `Analyse ${data.tag} (${data.description || data.tag}) for the selected period: trend, lows and highs, and anything unusual.`;
});
$('show').addEventListener('click', () => {
  state.from = $('from').value; state.to = $('to').value;
  markPreset('');
  load();
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
  if (location.hash.length > 2) location.hash = '#/';   // a tag picked on another page opens its trend on the dashboard
  liveCells.forEach((c, name) => c.cell.setAttribute('aria-pressed', String(name === tag)));
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
    const days = api(`/api/days?${dayQuery}`).catch(e => e);   // the figures and chart do not wait for this
    const trend = await api(`/api/trend?${query}`);
    if (id !== request) return;
    data = trend;
    history.replaceState(null, '', `?${new URLSearchParams({ ...(params.get('embed') ? { embed: 1 } : {}), tag: state.tag, from: state.from, to: state.to })}${location.hash}`);
    render();
    $('message').hidden = true;
    $('chartBox').style.opacity = 1;
    const reply = await days;
    if (id === request) drawDays(reply);
  } catch (e) {
    if (id !== request || e.message === 'unauthorized') return;
    $('result').hidden = true;
    data = null;
    showMessage(e.message, true);
    $('chartBox').style.opacity = 1;
  }
}

// One row of the summary card: label (with a note under it) on the left, value on the right.
function figure(label, value, unit, sub) {
  const box = document.createElement('div');
  box.className = 'fig';
  const lab = document.createElement('div'); lab.className = 'lab'; lab.textContent = label;
  if (sub) { const note = document.createElement('span'); note.className = 'sub'; note.textContent = sub; lab.append(note); }
  const val = document.createElement('div'); val.className = 'val'; val.textContent = value;
  if (unit) { const s = document.createElement('small'); s.textContent = ` ${unit}`; val.append(s); }
  box.append(lab, val);
  return box;
}

const when = (ms, oneDay) => (oneDay ? `at ${fmtTime(ms)}` : `${fmtDate(ms)} ${fmtTime(ms)}`);

function render() {
  $('result').hidden = false;
  const s = data.summary, u = data.unit;
  paintAvatar($('tagAvatar'), data.tag);
  $('tagName').textContent = data.description || data.tag;
  $('tagCode').textContent = [data.tag, u].filter(Boolean).join(' · ');
  const oneDay = data.to - data.from <= DAY;
  const span = isoDate(data.from) === isoDate(data.to - 1)
    ? `${fmtDate(data.from)}, ${fmtTime(data.from)} to ${fmtTime(data.to)}`
    : `${fmtDate(data.from)} ${fmtTime(data.from)} to ${fmtDate(data.to)} ${fmtTime(data.to)}`;
  $('period').textContent = span;

  // The headline is the last recorded value; the change is from the first recorded value of the period.
  const known = data.points.filter(p => p.v !== undefined);
  const first = known[0], last = known[known.length - 1];
  $('bigVal').textContent = last ? num(last.v) : 'No data';
  $('bigUnit').textContent = last ? (u || '') : '';
  $('result').dataset.dir = setChange($('chg'), known.length > 1 ? last.v - first.v : null, first ? first.v : 0, num);

  // Performance: where the last value sits between the period's low and high.
  $('perfLow').textContent = s.minutes ? num(s.min) : '-';
  $('perfHigh').textContent = s.minutes ? num(s.max) : '-';
  $('perfLowAt').textContent = s.minutes ? when(s.minAt, oneDay) : '';
  $('perfHighAt').textContent = s.minutes ? when(s.maxAt, oneDay) : '';
  const place = s.minutes && last && s.max > s.min ? (last.v - s.min) / (s.max - s.min) : .5;
  $('perfMark').style.left = `${Math.max(0, Math.min(1, place)) * 100}%`;
  $('perfMark').hidden = !s.minutes;

  // Minutes that have not happened yet are not missing, so they do not count against the period.
  const possible = Math.round((Math.min(data.to, Date.now()) - data.from) / MINUTE);
  const share = possible > 0 ? Math.min(100, Math.round(s.minutes / possible * 100)) : 0;
  const figs = [];
  if (s.minutes) {
    figs.push(
      figure('Average', num(s.avg), u, `${num(s.minutes)} recorded minutes`),
      s.total === undefined
        ? figure('Total', 'n/a', '', 'Only flow and power tags')
        : figure('Total', num(s.total), s.totalUnit, 'Average × recorded hours'),
      figure('Minimum', num(s.min), u, when(s.minAt, oneDay)),
      figure('Maximum', num(s.max), u, when(s.maxAt, oneDay)),
      figure('Range', num(s.max - s.min), u, 'Maximum − minimum'));
  } else {
    figs.push(figure('Average', 'n/a', '', 'Nothing recorded'), figure('Total', 'n/a'), figure('Minimum', 'n/a'), figure('Maximum', 'n/a'));
  }
  figs.push(figure('Recorded', `${share}%`, '', `${num(s.minutes)} of ${num(possible)} minutes`));
  $('figures').replaceChildren(...figs);

  $('chartNote').textContent = data.bucketMinutes > 1
    ? `Each point covers ${data.bucketMinutes} minutes: the line is the average and the shaded band is the minimum and maximum. Choose up to 3 days to see every minute.`
    : (s.minutes ? 'Gaps in the line mean nothing was recorded. History arrives about every 10 minutes.' : 'Choose another period, or check that this tag was recording.');
  drawChart();
  $('daysTable').style.opacity = .5;
  drawRowsIfOpen();
}

function cells(row, values) { for (const v of values) { const td = document.createElement('td'); td.textContent = v; row.append(td); } }
function head(table, names) {
  const tr = document.createElement('tr');
  for (const n of names) { const th = document.createElement('th'); th.textContent = n; tr.append(th); }
  table.tHead.replaceChildren(tr);
}

function drawDays(reply) {
  const failed = reply instanceof Error, days = failed ? [] : reply.days;
  const table = $('daysTable'), hasTotal = days.some(d => d.total !== undefined);
  $('daysEmpty').textContent = failed ? reply.message : 'No recorded days in the last 30 days of this period.';
  $('daysEmpty').hidden = days.length > 0;
  table.hidden = !days.length;
  table.style.opacity = 1;
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

// A period can hold thousands of rows, so they are built only when someone opens the table.
function drawRowsIfOpen() {
  if ($('paneRows').hidden || rowsShown === data) return;
  rowsShown = data;
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
  drawRowsIfOpen();
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

  const small = W < 520, fs = small ? 11 : 12.5;
  const m = { l: small ? 46 : 62, r: small ? 6 : 14, t: 10, b: 26 }, iw = W - m.l - m.r, ih = H - m.t - m.b;
  const band = data.bucketMinutes > 1;
  const lo = Math.min(...known.map(p => (band ? p.min : p.v))), hi = Math.max(...known.map(p => (band ? p.max : p.v)));
  const ticks = niceTicks(lo, hi, 5);
  const y0 = Math.min(ticks[0], lo), y1 = Math.max(ticks[ticks.length - 1], hi);
  const x = t => m.l + (t - data.from) / (data.to - data.from) * iw;
  const y = v => m.t + ih - (v - y0) / ((y1 - y0) || 1) * ih;

  for (const v of ticks) {
    el('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), stroke: 'var(--grid)' }, svg);
    const t = el('text', { x: m.l - 8, y: y(v) + 4, 'text-anchor': 'end', 'font-size': fs, fill: 'var(--ink3)' }, svg);
    t.textContent = num(v);
  }
  const { ticks: xt, step } = timeTicks(data.from, data.to, iw);
  for (const t of xt) {
    el('line', { x1: x(t), x2: x(t), y1: m.t + ih, y2: m.t + ih + 4, stroke: 'var(--axis)' }, svg);
    const label = el('text', { x: x(t), y: H - 7, 'text-anchor': 'middle', 'font-size': fs, fill: 'var(--ink3)' }, svg);
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
  const base = (m.t + ih).toFixed(1);   // the soft fill fades down to the bottom of the chart

  // The fill under the line fades from the line's colour to nothing.
  const fade = el('linearGradient', { id: 'fade', x1: 0, y1: 0, x2: 0, y2: 1 }, el('defs', {}, svg));
  el('stop', { offset: '0%', style: 'stop-color:var(--series);stop-opacity:.22' }, fade);
  el('stop', { offset: '100%', style: 'stop-color:var(--series);stop-opacity:0' }, fade);

  // A dashed line at the period's first value, so rises and falls read at a glance.
  const opening = value(known[0]);
  el('line', { x1: m.l, x2: W - m.r, y1: y(opening), y2: y(opening), stroke: 'var(--ink3)', 'stroke-dasharray': '2 4', opacity: .7 }, svg);
  for (const r of runs) {
    if (band) el('polygon', { points: [...r.map(p => at(p, p.max)), ...r.map(p => at(p, p.min)).reverse()].join(' '), fill: 'var(--band)' }, svg);
    else if (r.length > 1) el('polygon', { points: [`${x(r[0].t).toFixed(1)},${base}`, ...r.map(p => at(p, p.v)), `${x(r[r.length - 1].t).toFixed(1)},${base}`].join(' '), fill: 'url(#fade)' }, svg);
    if (r.length === 1) el('circle', { cx: x(r[0].t), cy: y(value(r[0])), r: 4, fill: 'var(--series)' }, svg);
    else el('polyline', { points: r.map(p => at(p, value(p))).join(' '), fill: 'none', stroke: 'var(--series)', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
  }

  const hair = el('line', { y1: m.t, y2: m.t + ih, stroke: 'var(--ink3)', 'stroke-dasharray': '3 3', visibility: 'hidden' }, svg);
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
