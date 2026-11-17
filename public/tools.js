'use strict';
// Menu (opened from the DCS Trends logo), the pages it opens, Turbine performance and Compare tags.
// Uses $, api, el, num, niceTicks, timeTicks, fmtDate, fmtTime, isoLocal, todayStart, state, openLimits from app.js.
(() => {
  const MIN = 60000, HOUR = 3600000, DAY_MS = 86400000;
  const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const SERIES = ['--s1', '--s2', '--s3', '--s4', '--s5', '--s6'];   // categorical slots, fixed order

  // ---------- Menu ----------
  const menu = $('menu');
  $('menuOpen').addEventListener('click', () => menu.showModal());
  menu.addEventListener('click', e => {
    if (e.target === menu) return menu.close();
    const item = e.target.closest('.m-item');
    if (!item) return;
    menu.close();   // page items are links (#/...), the router below shows the page
    const go = item.dataset.go;
    if (go === 'ai') { if ($('aiPanel').hidden) $('aiToggle').click(); }
    else if (go === 'theme') $('theme').click();
    else if (go === 'signout') $('signOut').click();
  });

  // ---------- Pages ----------
  // Each page has its own address, so Back, refresh and sharing a link all work.
  const PAGES = {
    '': { view: 'viewHome', title: 'DCS Trends' },
    performance: { view: 'viewPerf', title: 'Turbine performance', enter: () => enterPerf(), leave: () => leavePerf() },
    compare: { view: 'viewCompare', title: 'Compare tags', enter: () => openCompare() },
    enthalpy: { view: 'viewEnthalpy', title: 'Enthalpy', enter: () => window.enthalpyPage(true), leave: () => window.enthalpyPage(false) },
    limits: { view: 'viewLimits', title: 'Live limits', enter: () => openLimits() }
  };
  let current = null;
  function route() {
    const name = location.hash.replace(/^#\/?/, '');
    const page = PAGES[name] ? name : '';
    if (page === current) return;
    if (current !== null && PAGES[current].leave) PAGES[current].leave();
    current = page;
    for (const [key, p] of Object.entries(PAGES)) $(p.view).hidden = key !== page;
    // The Home button shows on every page except the dashboard; the menu marks the page that is open.
    $('homeBtn').hidden = !page;
    document.querySelectorAll('a.m-item').forEach(a => {
      const on = a.getAttribute('href').replace(/^#\/?/, '') === page;
      a.classList.toggle('on', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    document.title = page ? `${PAGES[page].title} · DCS Trends` : 'DCS Trends';
    window.scrollTo(0, 0);
    if (PAGES[page].enter) PAGES[page].enter();
  }
  window.addEventListener('hashchange', route);
  const pageShown = view => !$(view).hidden;

  // ---------- Shared ----------
  function periodOf(name) {
    const now = Math.floor(Date.now() / MIN) * MIN, t = todayStart();
    return { '1h': [now - HOUR, now], '8h': [now - 8 * HOUR, now], today: [t, now], yesterday: [t - DAY_MS, t], '7d': [t - 6 * DAY_MS, now], '30d': [t - 29 * DAY_MS, now] }[name];
  }
  const valueOf = (p, bucket) => (p.v === undefined ? undefined : bucket > 1 && p.avg !== undefined ? p.avg : p.v);
  const trend = (tag, from, to) => api(`/api/trend?tag=${encodeURIComponent(tag)}&from=${encodeURIComponent(isoLocal(from))}&to=${encodeURIComponent(isoLocal(to))}`);
  const chips = (box, names, current, onPick) => {
    box.replaceChildren(...names.map(([key, label]) => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = label; b.className = key === current ? 'on' : '';
      b.addEventListener('click', () => onPick(key));
      return b;
    }));
  };
  const when = t => `${fmtDate(t)} ${fmtTime(t)}`;
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  function lerpColor(a, b, k) {
    const pa = a.match(/\w\w/g).map(x => parseInt(x, 16)), pb = b.match(/\w\w/g).map(x => parseInt(x, 16));
    return `rgb(${pa.map((v, i) => Math.round(v + (pb[i] - v) * k)).join(',')})`;
  }
  function axes(svg, m, W, H, x, y, yTicks, from, to, fmtY) {
    for (const v of yTicks) {
      el('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), stroke: 'var(--grid)' }, svg);
      el('text', { x: m.l - 6, y: y(v) + 4, 'text-anchor': 'end', 'font-size': 11, fill: 'var(--ink3)' }, svg).textContent = fmtY(v);
    }
    if (from === undefined) return;
    const { ticks, step } = timeTicks(from, to, W - m.l - m.r);
    for (const t of ticks) {
      el('text', { x: x(t), y: H - 6, 'text-anchor': 'middle', 'font-size': 11, fill: 'var(--ink3)' }, svg).textContent =
        step >= DAY_MS || (to - from > DAY_MS && (t + 330 * MIN) % DAY_MS === 0) ? fmtDate(t).slice(0, 5) : fmtTime(t);
    }
  }

  // ---------- Turbine performance ----------
  let perfPeriod = '7d', perfData = null, perfX = 'dh', liveHist = {}, liveHistTimer = null;
  const avgOf = list => (list.length ? list.reduce((a, v) => a + v, 0) / list.length : undefined);
  const fix = (v, d) => (v === undefined || !Number.isFinite(v) ? '-' : Number(v).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d }));

  // Plant fits (on load, 11-16 Nov 2026). The drop fit explains much more (R2 0.52) than the inlet one (0.17).
  const FITS = {
    dh: { key: 'dh', a: 13.549, b: 0.00764, c: 0.0247, label: 'Ideal enthalpy drop Δh (DH_IS.PV), kJ/kg →', sym: 'Δh',
      note: 'Each dot is one minute on load. A bigger enthalpy drop means each tonne of steam makes more power, so the steam rate falls: the dots slope down. Darker dots are higher load; the dashed line is the plant fit.' },
    h1: { key: 'h', a: 12.702, b: 0.0019, c: 0.0221, label: 'Main steam inlet enthalpy h₁ (H_MS.PV), kJ/kg →', sym: 'h₁',
      note: 'Inlet enthalpy alone explains the steam rate less well than the drop, because the exhaust side (h₂, back-pressure) also matters. Darker dots are higher load; the dashed line is the plant fit.' }
  };
  $('perfXdrop').addEventListener('click', () => { perfX = 'dh'; $('perfXdrop').classList.add('on'); $('perfXh1').classList.remove('on'); drawScatter(); });
  $('perfXh1').addEventListener('click', () => { perfX = 'h1'; $('perfXh1').classList.add('on'); $('perfXdrop').classList.remove('on'); drawScatter(); });

  // Live now: enthalpy from the live main steam pressure and temperature, steam rates from live tags,
  // the drop and HP efficiency from the newest saved minute.
  function drawLiveNow() {
    if (!pageShown('viewPerf')) return;
    const v = tag => { const i = liveNow.get(tag); return i && Number.isFinite(i.v) ? i : null; };
    const P = v('PT_02.PV'), T = v('TT_07A.PV'), SR = v('STEAM_RATE.PV'), C = v('SR_CORR.PV');
    const st = P && T ? IF97.fromPlant(P.v, T.v) : null;
    const box = (label, value, unit, sub, main) => `<div class="ln${main ? ' main' : ''}"><span>${label}</span><b>${value}<small> ${unit}</small></b><em>${sub}</em></div>`;
    const dh = liveHist['DH_IS.PV'], si = liveHist['SR_IDEAL.PV'], eff = liveHist['HP_EFF.PV'];
    $('lnGrid').innerHTML = [
      box('Main steam enthalpy h₁', st && st.superheatC > 0 ? fix(st.h, 1) : '-', 'kJ/kg',
        st && st.superheatC > 0 ? `= ${fix(st.hKcal, 1)} kcal/kg · ${fix(st.superheatC, 1)} °C superheat` : 'Needs live PT_02.PV and TT_07A.PV', true),
      box('Steam rate', SR ? fix(SR.v, 3) : '-', 'TPH/MW', 'STEAM_RATE.PV, live'),
      box('Corrected steam rate', C ? fix(C.v, 3) : '-', 'TPH/MW', 'SR_CORR.PV, live'),
      box('Ideal enthalpy drop Δh', dh ? fix(dh.v, 1) : '-', 'kJ/kg', si ? `ideal steam rate ${fix(si.v, 3)} TPH/MW · ${fmtTime(dh.t)}` : 'main steam to exhaust'),
      box('HP section efficiency', eff ? fix(eff.v, 1) : '-', '%', eff ? `inlet to 1st extraction · ${fmtTime(eff.t)}` : 'inlet to 1st extraction')
    ].join('');
    const t = Math.max(P ? P.t : 0, T ? T.t : 0, SR ? SR.t : 0);
    $('lnTime').textContent = t ? `Live, read at ${fmtSec(t)}` : 'Waiting for live values';
  }
  async function loadLiveHistory() {
    const now = Math.floor(Date.now() / MIN) * MIN;
    const got = await Promise.all(['DH_IS.PV', 'SR_IDEAL.PV', 'HP_EFF.PV'].map(tag => trend(tag, now - 3 * HOUR, now + MIN).then(d => {
      const p = d.points.filter(x => x.v !== undefined).pop();
      return [tag, p ? { v: p.v, t: p.t } : null];
    }).catch(() => [tag, null])));
    liveHist = Object.fromEntries(got);
    drawLiveNow();
  }
  document.addEventListener('livereading', drawLiveNow);

  function enterPerf() {
    drawLiveNow();
    loadLiveHistory();
    clearInterval(liveHistTimer);
    liveHistTimer = setInterval(loadLiveHistory, 60000);
    loadPerf();
  }
  function leavePerf() { clearInterval(liveHistTimer); }

  async function loadPerf() {
    chips($('perfChips'), [['today', 'Today'], ['yesterday', 'Yesterday'], ['7d', '7D'], ['30d', '30D']], perfPeriod, k => { perfPeriod = k; loadPerf(); });
    $('perfMsg').hidden = false; $('perfMsg').textContent = 'Loading…'; $('perfBody').style.opacity = .4;
    const [from, to] = periodOf(perfPeriod);
    try {
      const tags = ['STEAM_RATE.PV', 'H_MS.PV', 'TG_LOAD.PV', 'SR_CORR.PV', 'DH_IS.PV', 'HP_EFF.PV'];
      const [sr, ...rest] = await Promise.all(tags.map(t => trend(t, from, to)));
      const b = sr.bucketMinutes, at = d => new Map(d.points.map(p => [p.t, valueOf(p, b)]));
      const [H, L, C, D, E] = rest.map(at);
      const rows = sr.points.map(p => ({ t: p.t, sr: valueOf(p, b), h: H.get(p.t), load: L.get(p.t), corr: C.get(p.t), dh: D.get(p.t), eff: E.get(p.t) }));
      perfData = { from: sr.from, to: sr.to, bucket: b, rows, onLoad: rows.filter(r => r.sr !== undefined && r.load !== undefined && r.load >= 10) };
      $('perfMsg').hidden = perfData.onLoad.length > 0;
      $('perfMsg').textContent = 'No minutes with the turbine on load (10 MW or more) in this period.';
      drawPerf();
    } catch (e) {
      if (e.message === 'unauthorized') return;
      $('perfMsg').hidden = false; $('perfMsg').textContent = e.message;
    }
    $('perfBody').style.opacity = 1;
  }

  function drawPerf() {
    const d = perfData; if (!d) return;
    const on = d.onLoad, pick = k => on.map(r => r[k]).filter(v => v !== undefined);
    const stat = (label, value, unit, sub) => `<div class="p-stat"><span>${label}</span><b>${value}<small> ${unit}</small></b><em>${sub}</em></div>`;
    $('perfStats').innerHTML = on.length ? [
      stat('Steam rate', fix(avgOf(pick('sr')), 3), 'TPH/MW', 'average on load'),
      stat('Corrected steam rate', fix(avgOf(pick('corr')), 3), 'TPH/MW', 'at 3440 kJ/kg and 19.5 MW'),
      stat('Ideal enthalpy drop Δh', fix(avgOf(pick('dh')), 1), 'kJ/kg', 'main steam to exhaust, average'),
      stat('Main steam enthalpy h₁', fix(avgOf(pick('h')), 1), 'kJ/kg', 'average on load'),
      stat('HP section efficiency', fix(avgOf(pick('eff')), 1), '%', 'inlet to 1st extraction, average'),
      stat('Time on load', num(Math.round(on.length * d.bucket / 60 * 10) / 10), 'h', `${fmtDate(d.from)} to ${fmtDate(d.to)}`)
    ].join('') : '';
    drawScatter(); drawCorr();
  }

  function drawScatter() {
    const d = perfData, svg = $('perfScatter'), box = svg.parentNode, W = box.clientWidth, Hh = box.clientHeight;
    svg.replaceChildren(); svg.setAttribute('viewBox', `0 0 ${W} ${Hh}`);
    if (!d) return;
    const fitDef = FITS[perfX], xk = fitDef.key;
    $('perfScatterNote').textContent = fitDef.note;
    // Each dot carries its x value under the name "h" so the drawing below is the same for both axes.
    const dots = d.onLoad.filter(r => r[xk] !== undefined).map(r => ({ ...r, h: r[xk] }));
    if (!dots.length) { $('perfLegend').textContent = ''; return; }
    const m = { l: 48, r: 12, t: 10, b: 34 };
    const hs = dots.map(r => r.h), srs = dots.map(r => r.sr), loads = dots.map(r => r.load);
    const xt = niceTicks(Math.min(...hs), Math.max(...hs), 5), yt = niceTicks(Math.min(...srs), Math.max(...srs), 4);
    const x0 = Math.min(xt[0], ...hs), x1 = Math.max(xt[xt.length - 1], ...hs), y0 = Math.min(yt[0], ...srs), y1 = Math.max(yt[yt.length - 1], ...srs);
    const x = v => m.l + (v - x0) / ((x1 - x0) || 1) * (W - m.l - m.r), y = v => m.t + (Hh - m.t - m.b) - (v - y0) / ((y1 - y0) || 1) * (Hh - m.t - m.b);
    axes(svg, m, W, Hh, x, y, yt, undefined, undefined, v => num(v));
    for (const v of xt) el('text', { x: x(v), y: Hh - 16, 'text-anchor': 'middle', 'font-size': 11, fill: 'var(--ink3)' }, svg).textContent = num(v);
    el('text', { x: (m.l + W - m.r) / 2, y: Hh - 2, 'text-anchor': 'middle', 'font-size': 11, fill: 'var(--ink2)' }, svg).textContent = fitDef.label;

    // Colour = load, one hue light (low) to dark (high).
    const lo = Math.min(...loads), hi = Math.max(...loads), cLo = css('--seq-lo'), cHi = css('--seq-hi');
    const colorOf = v => lerpColor(cLo, cHi, hi > lo ? (v - lo) / (hi - lo) : 1);
    const g = el('g', {}, svg);
    for (const r of dots) el('circle', { cx: x(r.h).toFixed(1), cy: y(r.sr).toFixed(1), r: 3.5, fill: colorOf(r.load), 'fill-opacity': .75 }, g);

    // The plant fit at the period's average load.
    const aL = loads.reduce((a, v) => a + v, 0) / loads.length, fit = v => fitDef.a - fitDef.b * v - fitDef.c * aL;
    // The fit line is clipped to the plot so it never runs over the axes when the data sits off the fit.
    const clip = el('clipPath', { id: 'perfPlotClip' }, el('defs', {}, svg));
    el('rect', { x: m.l, y: m.t, width: W - m.l - m.r, height: Hh - m.t - m.b }, clip);
    el('line', { x1: x(x0), x2: x(x1), y1: y(fit(x0)), y2: y(fit(x1)), stroke: 'var(--ink)', 'stroke-width': 2, 'stroke-dasharray': '6 4', 'clip-path': 'url(#perfPlotClip)' }, svg);
    $('perfLegend').innerHTML = `<span class="ramp" style="background:linear-gradient(90deg,${cLo},${cHi})"></span> TG load ${num(+lo.toFixed(1))} to ${num(+hi.toFixed(1))} MW
      <span class="fitkey"></span> Plant fit at ${num(+aL.toFixed(1))} MW: SR = ${fitDef.a} − ${fitDef.b} × ${fitDef.sym} − ${fitDef.c} × load`;

    const tip = $('perfTip'), ring = el('circle', { r: 6, fill: 'none', stroke: 'var(--ink)', 'stroke-width': 2, visibility: 'hidden' }, svg);
    svg.onpointermove = e => {
      const rect = svg.getBoundingClientRect(), px = e.clientX - rect.left, py = e.clientY - rect.top;
      let best = null, bd = 400;
      for (const r of dots) { const dx = x(r.h) - px, dy = y(r.sr) - py, dd = dx * dx + dy * dy; if (dd < bd) { bd = dd; best = r; } }
      if (!best) { tip.hidden = true; ring.setAttribute('visibility', 'hidden'); return; }
      ring.setAttribute('cx', x(best.h)); ring.setAttribute('cy', y(best.sr)); ring.setAttribute('visibility', 'visible');
      tip.innerHTML = `<b>${num(+best.sr.toFixed(3))} TPH/MW</b><div>${when(best.t)}</div><div>${fitDef.sym} ${num(+best.h.toFixed(1))} kJ/kg</div><div>Load ${num(+best.load.toFixed(2))} MW</div>`;
      tip.hidden = false;
      tip.style.left = `${Math.min(px + 12, W - tip.offsetWidth - 4)}px`; tip.style.top = `${Math.max(4, py - tip.offsetHeight - 10)}px`;
    };
    svg.onpointerleave = () => { tip.hidden = true; ring.setAttribute('visibility', 'hidden'); };
  }

  // Minute values jump about, so on long periods they are averaged into blocks of about 3 px each:
  // the slow drift this chart is for stays visible instead of a solid band.
  function binned(rows, width) {
    const size = Math.max(1, Math.ceil(rows.length / Math.max(1, width / 3)));
    if (size === 1) return { size, rows };
    const out = [];
    for (let i = 0; i < rows.length; i += size) {
      const part = rows.slice(i, i + size), mean = k => { const v = part.map(r => r[k]).filter(x => x !== undefined && x > 0 && x < 15); return v.length ? v.reduce((a, x) => a + x, 0) / v.length : undefined; };
      out.push({ t: part[0].t, sr: mean('sr'), corr: mean('corr') });
    }
    return { size, rows: out };
  }

  function drawCorr() {
    const p = perfData, svg = $('perfLine'), box = svg.parentNode, W = box.clientWidth, Hh = box.clientHeight;
    svg.replaceChildren(); svg.setAttribute('viewBox', `0 0 ${W} ${Hh}`);
    const bin = binned(p.rows, W - 60), d = { ...p, rows: bin.rows, bucket: p.bucket * bin.size };
    $('perfLineNote').textContent = d.bucket > 1 ? `Each point is the average of ${num(d.bucket)} minutes.` : 'Each point is one minute.';
    const rows = d.rows.filter(r => r.sr !== undefined || r.corr !== undefined);
    if (!rows.length) return;
    const all = rows.flatMap(r => [r.sr, r.corr]).filter(v => v !== undefined && v > 0 && v < 15);
    if (!all.length) return;
    const m = { l: 48, r: 12, t: 10, b: 24 }, yt = niceTicks(Math.min(...all), Math.max(...all), 4);
    const y0 = Math.min(yt[0], ...all), y1 = Math.max(yt[yt.length - 1], ...all);
    const x = t => m.l + (t - d.from) / (d.to - d.from) * (W - m.l - m.r), y = v => m.t + (Hh - m.t - m.b) - (v - y0) / ((y1 - y0) || 1) * (Hh - m.t - m.b);
    axes(svg, m, W, Hh, x, y, yt, d.from, d.to, v => num(v));
    const line = (key, color, width) => {
      let run = [];
      const flush = () => { if (run.length > 1) el('polyline', { points: run.join(' '), fill: 'none', stroke: color, 'stroke-width': width, 'stroke-linejoin': 'round' }, svg); run = []; };
      for (const r of d.rows) { const v = r[key]; if (v === undefined || !(v > 0 && v < 15)) flush(); else run.push(`${x(r.t).toFixed(1)},${y(v).toFixed(1)}`); }
      flush();
    };
    line('sr', 'var(--ink3)', 1.25);
    line('corr', 'var(--s1)', 2);
    const tip = $('perfTip2'), hair = el('line', { y1: m.t, y2: Hh - m.b, stroke: 'var(--ink3)', 'stroke-dasharray': '3 3', visibility: 'hidden' }, svg);
    svg.onpointermove = e => {
      const rect = svg.getBoundingClientRect(), px = e.clientX - rect.left;
      const t = d.from + (px - m.l) / (W - m.l - m.r) * (d.to - d.from), i = Math.round((t - d.from) / (d.bucket * MIN)), r = d.rows[i];
      if (!r) return;
      hair.setAttribute('x1', x(r.t)); hair.setAttribute('x2', x(r.t)); hair.setAttribute('visibility', 'visible');
      tip.innerHTML = `<div>${when(r.t)}</div><div><i class="sw" style="background:var(--s1)"></i>Corrected <b>${r.corr === undefined ? '-' : num(+r.corr.toFixed(3))}</b></div><div><i class="sw" style="background:var(--ink3)"></i>Actual <b>${r.sr === undefined ? '-' : num(+r.sr.toFixed(3))}</b></div>`;
      tip.hidden = false;
      tip.style.left = `${x(r.t) + tip.offsetWidth + 16 > W ? x(r.t) - tip.offsetWidth - 10 : x(r.t) + 10}px`; tip.style.top = '6px';
    };
    svg.onpointerleave = () => { tip.hidden = true; hair.setAttribute('visibility', 'hidden'); };
  }

  // ---------- Compare tags ----------
  const MAX_TAGS = 6, OVERLAY_MAX = 3;
  let cmpTags = [], cmpPeriod = 'today', cmpMode = 'stack', cmpData = [], cmpMatches = [];
  function openCompare() {
    if (!cmpTags.length) cmpTags = [state.tag || 'STEAM_RATE.PV'].filter(Boolean);
    loadCompare();
  }

  function drawPicked() {
    $('cmpPicked').replaceChildren(...cmpTags.map((tag, i) => {
      const c = document.createElement('span'); c.className = 'pick';
      c.innerHTML = `<i class="sw" style="background:var(${SERIES[i]})"></i>`;
      c.append(tag);
      const x = document.createElement('button'); x.type = 'button'; x.textContent = '×'; x.setAttribute('aria-label', `Remove ${tag}`);
      x.addEventListener('click', () => { cmpTags.splice(i, 1); loadCompare(); });
      c.append(x);
      return c;
    }));
    $('cmpAdd').disabled = cmpTags.length >= MAX_TAGS;
    $('cmpAdd').placeholder = cmpTags.length >= MAX_TAGS ? `Up to ${MAX_TAGS} tags` : 'Add a tag…';
    $('cmpOverlay').disabled = cmpTags.length > OVERLAY_MAX;
    $('cmpOverlay').title = cmpTags.length > OVERLAY_MAX ? `Overlay shows up to ${OVERLAY_MAX} tags so the lines stay easy to tell apart` : '';
    if (cmpTags.length > OVERLAY_MAX) cmpMode = 'stack';
    $('cmpStack').classList.toggle('on', cmpMode === 'stack');
    $('cmpOverlay').classList.toggle('on', cmpMode === 'overlay');
  }

  let addTimer;
  $('cmpAdd').addEventListener('input', () => {
    clearTimeout(addTimer);
    addTimer = setTimeout(async () => {
      const q = $('cmpAdd').value.trim();
      if (!q) { $('cmpMatches').hidden = true; return; }
      cmpMatches = (await api(`/api/tags?q=${encodeURIComponent(q)}`)).filter(m => !cmpTags.includes(m.tag)).slice(0, 8);
      $('cmpMatches').replaceChildren(...cmpMatches.map(m => {
        const li = document.createElement('li'); li.textContent = m.tag;
        const s = document.createElement('span'); s.textContent = [m.description, m.unit].filter(Boolean).join(', '); li.append(s);
        li.addEventListener('mousedown', e => { e.preventDefault(); addTag(m.tag); });
        return li;
      }));
      $('cmpMatches').hidden = !cmpMatches.length;
    }, 180);
  });
  $('cmpAdd').addEventListener('keydown', e => { if (e.key === 'Enter' && cmpMatches[0]) { e.preventDefault(); addTag(cmpMatches[0].tag); } });
  $('cmpAdd').addEventListener('blur', () => setTimeout(() => { $('cmpMatches').hidden = true; }, 150));
  function addTag(tag) {
    if (cmpTags.length >= MAX_TAGS || cmpTags.includes(tag)) return;
    cmpTags.push(tag); $('cmpAdd').value = ''; $('cmpMatches').hidden = true; loadCompare();
  }
  $('cmpStack').addEventListener('click', () => { cmpMode = 'stack'; drawPicked(); drawCompare(); });
  $('cmpOverlay').addEventListener('click', () => { if (cmpTags.length <= OVERLAY_MAX) { cmpMode = 'overlay'; drawPicked(); drawCompare(); } });

  async function loadCompare() {
    drawPicked();
    chips($('cmpChips'), [['1h', '1H'], ['8h', '8H'], ['today', 'Today'], ['yesterday', 'Yesterday'], ['7d', '7D'], ['30d', '30D']], cmpPeriod, k => { cmpPeriod = k; loadCompare(); });
    if (!cmpTags.length) { cmpData = []; drawCompare(); return; }
    const [from, to] = periodOf(cmpPeriod);
    $('cmpCharts').style.opacity = .4;
    const results = await Promise.all(cmpTags.map(t => trend(t, from, to).catch(e => ({ tag: t, error: e.message }))));
    cmpData = results.map((r, i) => ({ ...r, color: `var(${SERIES[i]})` }));
    $('cmpCharts').style.opacity = 1;
    drawCompare();
  }

  function drawCompare() {
    const box = $('cmpCharts'), tip = $('cmpTip');
    box.querySelectorAll('svg,.cmp-title,.cmp-err').forEach(n => n.remove());
    tip.hidden = true;
    const ok = cmpData.filter(d => !d.error && d.points);
    cmpData.filter(d => d.error).forEach(d => { const p = document.createElement('p'); p.className = 'cmp-err'; p.textContent = `${d.tag}: ${d.error}`; box.prepend(p); });
    drawTable(ok);
    if (!ok.length) return;
    const from = ok[0].from, to = ok[0].to, b = ok[0].bucketMinutes, W = box.clientWidth;
    const m = { l: 56, r: 12, t: 8, b: 6 };
    const x = t => m.l + (t - from) / (to - from) * (W - m.l - m.r);
    const panels = [];

    const drawLines = (svg, list, y) => {
      for (const d of list) {
        let run = [];
        const flush = () => { if (run.length > 1) el('polyline', { points: run.join(' '), fill: 'none', stroke: d.color, 'stroke-width': 2, 'stroke-linejoin': 'round' }, svg); else if (run.length === 1) { const [cx, cy] = run[0].split(','); el('circle', { cx, cy, r: 2.5, fill: d.color }, svg); } run = []; };
        for (const p of d.points) { const v = d.norm ? d.norm(valueOf(p, b)) : valueOf(p, b); if (v === undefined) flush(); else run.push(`${x(p.t).toFixed(1)},${y(v).toFixed(1)}`); }
        flush();
      }
    };
    const panel = (list, height, yTicks, y, fmtY, showTime) => {
      const svg = el('svg', { class: 'cmp-svg', viewBox: `0 0 ${W} ${height}`, height });
      axes(svg, { ...m, b: showTime ? 22 : m.b }, W, height, x, y, yTicks, showTime ? from : undefined, to, fmtY);
      drawLines(svg, list, y);
      const hair = el('line', { y1: m.t, y2: height - (showTime ? 22 : m.b), stroke: 'var(--ink3)', 'stroke-dasharray': '3 3', visibility: 'hidden' }, svg);
      box.append(svg); panels.push({ svg, hair });
      return svg;
    };

    if (cmpMode === 'overlay') {
      // Each tag drawn as % of its own min-to-max in this period, so tags with different units share one axis.
      for (const d of ok) {
        const vs = d.points.map(p => valueOf(p, b)).filter(v => v !== undefined);
        const lo = Math.min(...vs), hi = Math.max(...vs);
        d.norm = v => (v === undefined ? undefined : hi > lo ? (v - lo) / (hi - lo) * 100 : 50);
      }
      const title = document.createElement('div'); title.className = 'cmp-title';
      title.innerHTML = '<b>Each tag as % of its own range in this period</b><span>0 % = its lowest value, 100 % = its highest. Hover to read real values.</span>';
      box.append(title);
      const h = 300, y = v => m.t + (h - m.t - 22) - v / 100 * (h - m.t - 22);
      panel(ok, h, [0, 25, 50, 75, 100], y, v => `${v}%`, true);
    } else {
      ok.forEach((d, i) => {
        delete d.norm;
        const vs = d.points.map(p => valueOf(p, b)).filter(v => v !== undefined);
        const title = document.createElement('div'); title.className = 'cmp-title';
        title.innerHTML = `<i class="sw" style="background:${d.color}"></i><b></b><span></span>`;
        title.querySelector('b').textContent = d.tag;
        title.querySelector('span').textContent = [d.description, d.unit].filter(Boolean).join(' · ');
        box.append(title);
        const last = i === ok.length - 1, h = last ? 132 : 110;
        if (!vs.length) { const p = document.createElement('p'); p.className = 'cmp-err'; p.textContent = 'Nothing recorded in this period'; box.append(p); return; }
        const yt = niceTicks(Math.min(...vs), Math.max(...vs), 3);
        const y0 = Math.min(yt[0], ...vs), y1 = Math.max(yt[yt.length - 1], ...vs);
        const bottom = last ? 22 : m.b, y = v => m.t + (h - m.t - bottom) - (v - y0) / ((y1 - y0) || 1) * (h - m.t - bottom);
        panel([d], h, yt, y, v => num(v), last);
      });
    }

    // One crosshair across every panel; the tooltip lists each tag's real value at that time.
    const move = e => {
      const rect = e.currentTarget.getBoundingClientRect(), px = e.clientX - rect.left;
      const t = from + (px - m.l) / (W - m.l - m.r) * (to - from), i = Math.round((t - from) / (b * MIN));
      const at = ok[0].points[i];
      if (!at) return;
      panels.forEach(p => { p.hair.setAttribute('x1', x(at.t)); p.hair.setAttribute('x2', x(at.t)); p.hair.setAttribute('visibility', 'visible'); });
      tip.innerHTML = `<div class="tt">${when(at.t)}</div>` + ok.map(d => {
        const p = d.points[i], v = p ? valueOf(p, b) : undefined;
        return `<div><i class="sw" style="background:${d.color}"></i>${esc(d.tag)} <b>${v === undefined ? 'not recorded' : `${num(v)} ${esc(d.unit || '')}`}</b></div>`;
      }).join('');
      tip.hidden = false;
      const bx = box.getBoundingClientRect(), ax = x(at.t);
      tip.style.left = `${ax + tip.offsetWidth + 20 > W ? ax - tip.offsetWidth - 10 : ax + 12}px`;
      tip.style.top = `${e.clientY - bx.top + box.scrollTop - 10}px`;
    };
    const leave = () => { tip.hidden = true; panels.forEach(p => p.hair.setAttribute('visibility', 'hidden')); };
    panels.forEach(p => { p.svg.addEventListener('pointermove', move); p.svg.addEventListener('pointerleave', leave); });
  }

  function drawTable(list) {
    const body = $('cmpTable').tBodies[0];
    body.replaceChildren(...list.map(d => {
      const s = d.summary || {}, tr = document.createElement('tr');
      const last = [...d.points].reverse().find(p => p.v !== undefined);
      const possible = Math.max(1, Math.round((Math.min(d.to, Date.now()) - d.from) / MIN));
      const cells = [d.tag, d.unit || '', s.minutes ? num(s.min) : '-', s.minutes ? num(s.avg) : '-', s.minutes ? num(s.max) : '-', last ? num(last.v) : '-', `${Math.min(100, Math.round((s.minutes || 0) / possible * 100))}%`];
      for (const c of cells) { const td = document.createElement('td'); td.textContent = c; tr.append(td); }
      const sw = document.createElement('i'); sw.className = 'sw'; sw.style.background = d.color; tr.firstChild.prepend(sw);
      return tr;
    }));
    $('cmpTableWrap').hidden = !list.length;
  }

  let resize;
  window.addEventListener('resize', () => {
    clearTimeout(resize);
    resize = setTimeout(() => { if (pageShown('viewPerf')) drawPerf(); if (pageShown('viewCompare')) drawCompare(); }, 150);
  });

  route();
})();
