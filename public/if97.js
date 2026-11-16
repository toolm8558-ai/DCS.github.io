'use strict';
// IAPWS-IF97 steam properties used by both the browser (window.IF97) and the server (require).
// Region 2 (superheated steam) for enthalpy and entropy, Region 4 for the boiling point.
// Checked against the IF97 test values and steam tables for superheated steam up to 10 MPa;
// close to saturation at high pressure it is not reliable, so callers keep within that range.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.IF97 = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  const R = 0.461526;                 // kJ/(kg K), gas constant of water
  const ATM = 1.0332;                 // kgf/cm2 of atmosphere, gauge to absolute
  const KGF_TO_MPA = 0.0980665;
  const KCAL = 4.1868;                // kJ per kcal

  // Ideal-gas part: 9 terms. Residual (real steam) part: 43 terms.
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

  // p in MPa absolute, T in kelvin. Returns h (kJ/kg), s (kJ/kg K) and every intermediate number.
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

  // Saturation (boiling) temperature in kelvin at p MPa, Region 4.
  function tsat(p) {
    const n = [0.11670521452767e4, -0.72421316703206e6, -0.17073846940092e2, 0.12020824702470e5, -0.32325550322333e7, 0.14915108613530e2, -0.48232657361591e4, 0.40511340542057e6, -0.23855557567849, 0.65017534844798e3];
    const b = p ** 0.25, E = b * b + n[2] * b + n[5], F = n[0] * b * b + n[3] * b + n[6], G = n[1] * b * b + n[4] * b + n[7];
    const D = 2 * G / (-F - Math.sqrt(F * F - 4 * E * G));
    return (n[9] + D - Math.sqrt((n[9] + D) ** 2 - 4 * (n[8] + n[9] * D))) / 2;
  }

  // Temperature (K) at pressure p with entropy s1: the end of an ideal expansion. Null if it would be wet.
  function isentropicT(p, s1) {
    let lo = tsat(p), hi = 1073.15;
    if (region2(p, lo).s > s1) return null;
    for (let k = 0; k < 80; k++) { const m = (lo + hi) / 2; if (region2(p, m).s > s1) hi = m; else lo = m; }
    return lo;
  }

  const absMPa = gaugeKgf => (gaugeKgf + ATM) * KGF_TO_MPA;

  // Everything about steam at a plant reading: gauge kgf/cm2 and degrees C.
  function fromPlant(gaugeKgf, tempC) {
    const p = absMPa(gaugeKgf), T = tempC + 273.15, ts = tsat(p), r = region2(p, T);
    return {
      pressureAta: gaugeKgf + ATM, pressureMPa: p, tempC, saturationC: ts - 273.15, superheatC: T - ts,
      h: r.h, hKcal: r.h / KCAL, s: r.s, inRange: p <= 10 && T - ts >= 15
    };
  }

  return { R, ATM, KGF_TO_MPA, KCAL, J0, N0, I, J, N, region2, tsat, isentropicT, absMPa, fromPlant };
}));
