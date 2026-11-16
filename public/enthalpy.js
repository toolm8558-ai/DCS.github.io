'use strict';
// Enthalpy panel: works out main steam enthalpy step by step from the live PT_02.PV and TT_07A.PV,
// and the HP section efficiency from the 1st extraction, using IAPWS-IF97 Region 2 (superheated steam).
// Uses $, api, liveNow, fmtDate, fmtSec, fmtTime, isoLocal from app.js.
(() => {
  const TAGS = { p: 'PT_02.PV', t: 'TT_07A.PV', flow: 'FT_02A.PV', load: 'TG_LOAD.PV', p2: 'PT_103_1.PV', t2: 'TE103.PV' };
  const ATM = 1.0332, KGF_TO_MPA = 0.0980665, KCAL = 4.1868, R = 0.461526;

  // IAPWS-IF97 Region 2 coefficients: ideal-gas part (9 terms) and residual part (43 terms).
  const J0 = [0, 1, -5, -4, -3, -2, -1, 2, 3];
  const N0 = [-0.96927686500217e1, 0.10086655968018e2, -0.56087911283020e-2, 0.71452738081455e-1, -0.40710498223928, 0.14240819171444e1, -0.43839511319450e1, -0.28408632460772, 0.21268463753307e-1];
  const I = [1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 4, 4, 4, 5, 6, 6, 6, 7, 7, 7, 8, 8, 9, 10, 10, 10, 16, 16, 18, 20, 20, 20, 21, 22, 23, 24, 24, 24];
  const J = [0, 1, 2, 3, 6, 1, 2, 4, 7, 36, 0, 1, 3, 6, 35, 1, 2, 3, 7, 3, 16, 35, 0, 11, 25, 8, 36, 13, 4, 10, 14, 29, 50, 57, 20, 35, 48, 21, 53, 39, 26, 40, 58];
  const N = [-0.17731742473213e-2, -0.17834862292358e-1, -0.45996013696365e-1, -0.57581259083432e-1, -0.50325278727930e-1,
    -0.33032641670203e-4, -0.18948987516315e-3, -0.39392777243355e-2, -0.43797295650573e-1, -0.26674547914087e-4,
    0.20481737692309e-7, 0.43870667284435e-6, -0.32277677238570e-4, -0.15033924542148e-2, -0.40668253562649e-1,
    -0.78847309559367e-9, 0.12790717852285e-7, 0.48225372718507e-6, 0.22922076337661e-5, -0.16714766451061e-10,
    -0.21171472321355e-2, -0.23895741934104e2, -0.59059564324270e-17, -0.12621808899101e-5, -0.38946842435739e-1,
    0.11256211360459e-10, -0.82311340897998e1, 0.19809712802088e-7, 0.10406965210174e-18, -0.10234747095929e-12,
    -0.10018179379511e-8, -0.80882908646985e-10, 0.10693031879409, -0.33662250574171, 0.89185845355421e-24,
    0.30629316876232e-12, -0.42002467698208e-5, -0.59056029685639e-21, 0.37826947613457e-5, -0.12768608934681e-14,
    0.73087610595061e-28, 0.55414715350778e-16, -0.94369707241210e-5];

  // p in MPa absolute, T in kelvin. Returns every intermediate number so the panel can show them.
  function region2(p, T) {
    const tau = 540 / T, pi = p;
    let g0 = Math.log(pi), g0t = 0, gr = 0, grt = 0;
    N0.forEach((n, i) => { g0 += n * tau ** J0[i]; g0t += n * J0[i] * tau ** (J0[i] - 1); });
    const terms = N.map((n, i) => {
      const part = n * pi ** I[i] * J[i] * (tau - 0.5) ** (J[i] - 1);
      gr += n * pi ** I[i] * (tau - 0.5) ** J[i];
      grt += part;
      return part;
    });
    return { tau, pi, g0t, grt, terms, h: R * T * tau * (g0t + grt), s: R * (tau * (g0t + grt) - (g0 + gr)) };
  }
  const h = (p, T) => region2(p, T).h;
  const s = (p, T) => region2(p, T).s;

  // Saturation temperature (K) at p MPa, IF97 Region 4.
  function tsat(p) {
    const n = [0.11670521452767e4, -0.72421316703206e6, -0.17073846940092e2, 0.12020824702470e5, -0.32325550322333e7, 0.14915108613530e2, -0.48232657361591e4, 0.40511340542057e6, -0.23855557567849, 0.65017534844798e3];
    const b = p ** 0.25, E = b * b + n[2] * b + n[5], F = n[0] * b * b + n[3] * b + n[6], G = n[1] * b * b + n[4] * b + n[7];
    const D = 2 * G / (-F - Math.sqrt(F * F - 4 * E * G));
    return (n[9] + D - Math.sqrt((n[9] + D) ** 2 - 4 * (n[8] + n[9] * D))) / 2;
  }

  // Temperature at pressure p with entropy s1 (the ideal, loss-free end of the expansion).
  function isentropicT(p, s1) {
    let lo = tsat(p), hi = 1073.15;
    if (s(p, lo) > s1) return null;   // would be wet steam: not shown here
    for (let k = 0; k < 80; k++) { const m = (lo + hi) / 2; if (s(p, m) > s1) hi = m; else lo = m; }
    return lo;
  }

  const absMPa = g => (g + ATM) * KGF_TO_MPA;
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
