'use strict';
// Enthalpy panel: works out main steam enthalpy step by step from the live PT_02.PV and TT_07A.PV,
// and the HP section efficiency from the 1st extraction, using IAPWS-IF97 Region 2 (superheated steam).
// Uses $, api, liveNow, fmtDate, fmtSec, fmtTime, isoLocal from app.js and IF97 from if97.js.
(() => {
  const TAGS = { p: 'PT_02.PV', t: 'TT_07A.PV', flow: 'FT_02A.PV', load: 'TG_LOAD.PV', p2: 'PT_103_1.PV', t2: 'TE103.PV' };
  // Steam properties come from if97.js, shared with the server's AI assistant.
  const { ATM, KGF_TO_MPA, KCAL, R, I, J, N, region2, tsat, isentropicT, absMPa } = IF97;
  const h = (p, T) => region2(p, T).h;
  const f = (v, d = 2) => Number(v).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
  const sci = v => (v === 0 ? '0' : v.toExponential(4).replace('e', ' × 10^'));
  const row = (label, formula, value) => `<div class="h-row"><span>${label}</span><code>${formula}</code><b>${value}</b></div>`;
  const step = (n, title, body, note) => `<section class="h-step"><div class="h-num">${n}</div><div class="h-body"><h4>${title}</h4>${body}${note ? `<p class="h-note">${note}</p>` : ''}</div></section>`;

  let open = false, coeffOpen = false, extraction = null, extractionTimer = null;

  function liveValue(tag) {
    const item = liveNow.get(tag);
    return item && Number.isFinite(Number(item.v)) ? { v: Number(item.v), t: item.t } : null;
  }

  function renderMain() {
    const P = liveValue(TAGS.p), T = liveValue(TAGS.t), F = liveValue(TAGS.flow), L = liveValue(TAGS.load);
    const box = $('hMain');
    if (!P || !T) { box.innerHTML = `<p class="h-warn">Waiting for live ${TAGS.p} and ${TAGS.t}. These two tags must be in the live list.</p>`; return null; }

    const ata = P.v + ATM, p = absMPa(P.v), tK = T.v + 273.15, ts = tsat(p), sup = tK - ts, r = region2(p, tK);
    const hk = r.h, kcal = hk / KCAL;
    const hot = h(p, tK + 10) - hk, press = h(absMPa(P.v + 5), tK) - hk;
    $('hTime').textContent = `Live, read at ${fmtSec(Math.max(P.t, T.t))}`;
    $('hHero').innerHTML = `<b>${f(hk, 1)}</b><small>kJ/kg</small><span>= ${f(kcal, 1)} kcal/kg</span>`;

    const rows = r.terms.map((c, i) => `<tr><td>${i + 1}</td><td>${I[i]}</td><td>${J[i]}</td><td>${sci(N[i])}</td><td>${c.toFixed(6)}</td></tr>`).join('');
    const warn = p > 10 || sup < 15 ? '<p class="h-warn">Outside the range this page is checked for (superheated steam up to 10 MPa). Treat the result as an estimate.</p>' : '';

    box.innerHTML = warn
      + step(1, 'Read the live values',
        row('Main steam pressure', TAGS.p, `${f(P.v)} kgf/cm² (gauge)`)
        + row('Main steam temperature', TAGS.t, `${f(T.v, 1)} °C`),
        'Gauge pressure is measured above the atmosphere. Steam tables need absolute pressure.')
      + step(2, 'Change to absolute pressure',
        row('Absolute pressure', `p(ata) = ${f(P.v)} + ${ATM}`, `${f(ata)} ata`)
        + row('In MPa', `p(MPa) = ${f(ata)} × ${KGF_TO_MPA}`, `${f(p, 4)} MPa`))
      + step(3, 'Check that the steam is superheated',
        row('Boiling point at this pressure', 'T<sub>sat</sub>(p), IAPWS-IF97 Region 4', `${f(ts - 273.15, 1)} °C`)
        + row('Superheat', `${f(T.v, 1)} − ${f(ts - 273.15, 1)}`, `${f(sup, 1)} °C`),
        sup > 0 ? 'The steam is above its boiling point, so it is superheated: its enthalpy depends on both pressure and temperature.' : 'The steam is not above its boiling point, so this method does not apply.')
      + step(4, 'Work out enthalpy with IAPWS-IF97 (Region 2)',
        `<div class="h-formula">h = R × T × τ × (γ°<sub>τ</sub> + γʳ<sub>τ</sub>)</div>`
        + row('Temperature in kelvin', `T = ${f(T.v, 1)} + 273.15`, `${f(tK)} K`)
        + row('Reduced temperature', `τ = 540 ÷ ${f(tK)}`, f(r.tau, 5))
        + row('Reduced pressure', 'π = p ÷ 1 MPa', f(r.pi, 4))
        + row('Ideal-gas part (9 terms)', 'γ°<sub>τ</sub> = Σ n°ᵢ Jᵢ τ<sup>Jᵢ−1</sup>', f(r.g0t, 5))
        + row('Real-steam correction (43 terms)', 'γʳ<sub>τ</sub> = Σ nᵢ π<sup>Iᵢ</sup> Jᵢ (τ−0.5)<sup>Jᵢ−1</sup>', f(r.grt, 5))
        + row('Specific enthalpy', `${R} × ${f(tK)} × ${f(r.tau, 5)} × (${f(r.g0t, 5)} + ${f(r.grt, 5)})`, `<em>${f(hk, 1)} kJ/kg</em>`)
        + `<details id="hCoeff"${coeffOpen ? ' open' : ''}><summary>Show the 43 real-steam terms</summary><div class="h-table"><table><thead><tr><th>i</th><th>I</th><th>J</th><th>n</th><th>term</th></tr></thead><tbody>${rows}</tbody></table></div></details>`,
        'R is the gas constant of water, 0.461526 kJ/(kg·K). The coefficients n, I and J are fixed by the IAPWS-IF97 standard.')
      + step(5, 'Change units',
        row('In kcal/kg', `${f(hk, 1)} ÷ ${KCAL}`, `${f(kcal, 1)} kcal/kg`),
        'Specific enthalpy is the heat held by each kilogram of steam, counted from water at 0.01 °C.')
      + (F && L ? step(6, 'Heat carried into the turbine',
        row('Total enthalpy flow', `${f(F.v)} t/h × 1000 ÷ 3600 × ${f(hk, 1)} ÷ 1000`, `${f(F.v / 3.6 * hk / 1000, 1)} MW`)
        + row('TG load at the same time', TAGS.load, `${f(L.v)} MW`),
        'This is not the turbine efficiency: the steam leaving the turbine still carries most of this heat to the process.') : '')
      + step(F && L ? 7 : 6, 'What moves enthalpy the most',
        row('Temperature +10 °C', `h(p, T+10) − h`, `${hot > 0 ? '+' : ''}${f(hot, 1)} kJ/kg`)
        + row('Pressure +5 kgf/cm²', `h(p+5, T) − h`, `${press > 0 ? '+' : ''}${f(press, 1)} kJ/kg`),
        'Temperature has the bigger effect. Higher enthalpy means each tonne of steam does more work, so the steam rate (TPH/MW) falls.');

    const d = $('hCoeff');
    if (d) d.addEventListener('toggle', () => { coeffOpen = d.open; });
    return { p, tK, h: hk, s: r.s };
  }

  async function loadExtraction() {
    const newest = Math.max(...[...liveNow.values()].map(i => i.t).filter(Number.isFinite), 0);
    if (!newest) return;
    const from = isoLocal(newest - 2 * 3600000), to = isoLocal(newest + 60000);
    const lastOf = async tag => {
      const d = await api(`/api/trend?tag=${encodeURIComponent(tag)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
      const p = d.points.filter(x => x.v !== undefined).pop();
      return p ? { v: p.v, t: p.t } : null;
    };
    try {
      const [p2, t2] = await Promise.all([lastOf(TAGS.p2), lastOf(TAGS.t2)]);
      extraction = { p2, t2 };
    } catch (e) {
      extraction = { error: e.message };
    }
    if (open) renderEfficiency();
  }

  function renderEfficiency() {
    const box = $('hEff'), inlet = renderMain.last;
    if (!inlet) { box.innerHTML = ''; return; }
    if (!extraction) { box.innerHTML = '<p class="h-note">Loading the 1st extraction values…</p>'; return; }
    if (extraction.error) { box.innerHTML = `<p class="h-warn">${extraction.error}</p>`; return; }
    const { p2: P2, t2: T2 } = extraction;
    if (!P2 || !T2) { box.innerHTML = `<p class="h-warn">No saved values for ${TAGS.p2} or ${TAGS.t2} in the last 2 hours.</p>`; return; }

    const p2 = absMPa(P2.v), t2K = T2.v + 273.15, ts2 = tsat(p2);
    if (t2K <= ts2 + 1) { box.innerHTML = `<p class="h-warn">The 1st extraction (${f(T2.v, 1)} °C) is not above its boiling point (${f(ts2 - 273.15, 1)} °C), so its enthalpy cannot be read from pressure and temperature.</p>`; return; }
    const h2 = h(p2, t2K), t2s = isentropicT(p2, inlet.s);
    if (t2s === null) { box.innerHTML = '<p class="h-warn">The ideal expansion would end as wet steam, which this page does not work out.</p>'; return; }
    const h2s = h(p2, t2s), actual = inlet.h - h2, ideal = inlet.h - h2s, eta = actual / ideal * 100;

    box.innerHTML = `<div class="h-formula">η = (h₁ − h₂,actual) ÷ (h₁ − h₂,isentropic) × 100</div>`
      + `<div class="h-hero h-hero-sm"><b>${f(eta, 1)}</b><small>%</small><span>HP section, inlet to 1st extraction, ${fmtTime(Math.max(P2.t, T2.t))} ${fmtDate(Math.max(P2.t, T2.t))}</span></div>`
      + step('a', 'Inlet: h₁ and entropy s₁', row('From step 4', 'h₁', `${f(inlet.h, 1)} kJ/kg`) + row('Entropy', 's₁ = R × (τ(γ°<sub>τ</sub>+γʳ<sub>τ</sub>) − (γ°+γʳ))', `${f(inlet.s, 4)} kJ/kg·K`))
      + step('b', '1st extraction, measured',
        row('Pressure', `${TAGS.p2}: ${f(P2.v)} kgf/cm² g → (${f(P2.v)} + ${ATM}) × ${KGF_TO_MPA}`, `${f(p2, 4)} MPa`)
        + row('Temperature', TAGS.t2, `${f(T2.v, 1)} °C`)
        + row('Actual outlet enthalpy', 'h₂,actual = h(p₂, T₂)', `${f(h2, 1)} kJ/kg`))
      + step('c', 'Ideal (isentropic) end point',
        row('Same entropy at p₂', `find T where s(p₂, T) = ${f(inlet.s, 4)}`, `${f(t2s - 273.15, 1)} °C`)
        + row('Ideal outlet enthalpy', 'h₂,isentropic = h(p₂, T)', `${f(h2s, 1)} kJ/kg`),
        'With no friction or leakage the steam would expand at constant entropy and end cooler, at this temperature.')
      + step('d', 'Efficiency',
        row('Actual drop', `${f(inlet.h, 1)} − ${f(h2, 1)}`, `${f(actual, 1)} kJ/kg`)
        + row('Ideal drop', `${f(inlet.h, 1)} − ${f(h2s, 1)}`, `${f(ideal, 1)} kJ/kg`)
        + row('Isentropic efficiency', `${f(actual, 1)} ÷ ${f(ideal, 1)} × 100`, `<em>${f(eta, 1)} %</em>`),
        'Losses in nozzles and blades, leakage and partial admission keep the actual drop below the ideal one. Extraction values are saved history, about 10 minutes behind live.');
  }

  function render() {
    if (!open) return;
    renderMain.last = renderMain();
    renderEfficiency();
  }

  $('hOpen').addEventListener('click', () => {
    open = true;
    $('hDialog').showModal();
    render();
    loadExtraction();
    clearInterval(extractionTimer);
    extractionTimer = setInterval(loadExtraction, 60000);
  });
  $('hDialog').addEventListener('close', () => { open = false; clearInterval(extractionTimer); });
  $('hClose').addEventListener('click', () => $('hDialog').close());
  $('hDialog').addEventListener('click', e => { if (e.target === $('hDialog')) $('hDialog').close(); });

  // app.js calls this after every live reading.
  window.onLiveReading = render;
})();
