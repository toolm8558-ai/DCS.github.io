# Plant knowledge for the DCS Trends assistant

This text is given to the AI assistant with every question. Keep it factual: every number here comes
from the plant's own data, the plant's notes, or a standard formula. Update it when the plant changes.

## The plant
- Sugar-mill cogeneration plant. A bagasse-fired boiler makes superheated main steam (about 80 kgf/cm2 g,
  510-530 C). It drives an extraction / back-pressure steam turbine-generator (TG, about 20 MW, range 0-35 MW).
- The turbine has 1st, 2nd and 3rd extractions, and its exhaust (PT_106_1.PV, about +0.17 kgf/cm2 g, about
  1.2 ata) goes to the sugar process. It is not a condensing turbine: the exhaust is not a vacuum.
- Steam leaving the turbine still carries most of its heat to the process, so heat into the turbine divided
  by MW is not a turbine efficiency.
- All times are India time (IST). History (trend_minute) is saved about every 10 minutes, so it runs a little
  behind the live values, which update every second.

## Key tags (from tag_info)
| Tag | Meaning | Unit |
|---|---|---|
| TG_LOAD.PV | TG load (power generated) | MW |
| 132KV_MW.PV | 132 kV grid import/export | MW |
| TUR_SPD.PV | Turbine speed | rpm |
| FT_02A.PV, FT_02B.PV | Main steam flow A / B transmitters | t/h |
| FT_02AB_FINAL.IN | Main steam flow, 1-out-of-2 selected value | t/h |
| PT_02.PV | Boiler main steam pressure (gauge) | kgf/cm2 |
| PT_01.PV | Boiler drum pressure (gauge) | kgf/cm2 |
| TT_07A.PV, TT_07B.PV, TT_07C.PV | Main steam temperature A / B / C | C |
| LT_01.PV | Boiler drum level A | % |
| FT_01A.PV, FT_01B.PV | Feed water flow 1 / 2 | t/h |
| PT_100A.PV | Furnace pressure A | mmwc |
| PT_103_1.PV, TE103.PV | 1st extraction steam pressure / temperature | kgf/cm2 g, C |
| PT_104_2.PV | 2nd extraction steam pressure | kgf/cm2 g |
| TE105.PV | 3rd extraction steam temperature | C |
| 2_FT_154.PV | 3rd extraction steam flow | t/h |
| PT_106_1.PV | Turbine exhaust steam pressure | kgf/cm2 g |
| PT_404.PV | 3 ata steam to process line | kgf/cm2 |
| STEAM_RATE.PV | Steam rate = FT_02A.PV / TG_LOAD.PV, saved every second and every minute (not saved below 1 MW) | TPH/MW |
| H_MS.PV | Main steam enthalpy from PT_02.PV and TT_07A.PV by IAPWS-IF97, every second and minute (not saved without 15 C of superheat) | kJ/kg |
| SR_CORR.PV | Corrected steam rate, STEAM_RATE.PV brought to 3440 kJ/kg and 19.5 MW with the plant fit (only at 10 MW or more) | TPH/MW |

STEAM_RATE.PV, H_MS.PV and SR_CORR.PV are worked out by the SteamRate program from the other tags, not
measured. They can be read with get_live_values, get_trend and compare_periods like any other tag; a rising
SR_CORR.PV trend is the clearest sign of the turbine itself getting worse.

PT_104_2.PV (2nd extraction) and TE105.PV (3rd extraction) belong to different points; do not pair them.
No tag measures bagasse in tonnes (only feeder VFD speeds), and no tag for economiser inlet feed water
temperature has been confirmed.

## Steam rate (specific steam consumption)
- Steam rate = steam flow (TPH) / TG load (MW). Units: 1 TPH/MW = 1 t/MWh = 1 kg/kWh.
- The plant's handwritten note uses about 6 TPH/MW at 1 MW as a reference; one example reading was
  57.9 / 10.05 = 5.76 TPH/MW.
- Compare a steam rate only with the same load band and the same steam conditions, never with one fixed
  number: steam rate rises at low load.
- On this plant (11-16 Nov 2026, load >= 10 MW): typical 5.7-5.9 TPH/MW at 18-21 MW; about 5.9-6.05 at 10-16 MW.

## Enthalpy
- Specific enthalpy h (kJ/kg) is the heat in each kg of steam. kcal/kg = kJ/kg / 4.1868.
- For superheated steam h depends on both pressure and temperature. It is worked out with IAPWS-IF97
  Region 2: h = R x T x tau x (gamma0_tau + gammar_tau), tau = 540 / T(K), pi = p(MPa), R = 0.461526 kJ/(kg K).
- Steps: absolute pressure ata = gauge kgf/cm2 + 1.0332; MPa = ata x 0.0980665; T(K) = C + 273.15; check the
  steam is above its boiling point (superheated); then the formula.
- Typical main steam: 81.9 kgf/cm2 g and 519.7 C give h = 3446.4 kJ/kg (823.2 kcal/kg), 224 C of superheat.
- Sensitivity at those conditions: +10 C raises h by about 24.5 kJ/kg; +5 kgf/cm2 lowers h by about 5.4 kJ/kg.
  Temperature matters about five times more than pressure.
- Total enthalpy flow = steam flow x h. At 117.6 t/h that is about 112 MW of heat into the turbine.
- The steam_properties tool works this out; it is checked for superheated steam up to 10 MPa only.

## Steam rate and enthalpy move opposite ways
- Lower enthalpy (and lower enthalpy drop) means each tonne of steam does less work, so more steam is needed
  for the same MW: enthalpy down, steam rate up; enthalpy up, steam rate down.
- Measured on this plant, 18-21 MW: main steam about 494 C (h 3375-3390) gave 5.85 TPH/MW; about 530 C
  (h 3465-3480) gave 5.72 TPH/MW.
- Plant fit (11-16 Nov 2026, 7282 minutes, load >= 10 MW):
  steam rate = 12.702 - 0.00190 x h - 0.0221 x load. So +10 kJ/kg of enthalpy gives about -0.33 % steam rate,
  +10 C gives about -0.8 %, and +1 MW gives about -0.022 TPH/MW.
- At about 18.8 MW, 10 kJ/kg lower enthalpy costs about 0.36 t/h more steam (about 9 t/day).
- Corrected steam rate (same steam conditions and load, to judge the turbine itself):
  SR_corrected = SR_actual + 0.0019 x (h - 3440) + 0.0221 x (load - 19.5). A slow rise in SR_corrected points to
  turbine wear or leakage rather than steam conditions.
- Enthalpy and load explain only about 17 % of the minute-to-minute change in steam rate (R2 = 0.17). Extraction
  and process steam demand, exhaust back-pressure and flow measurement also move it. Say so when it matters.

## Turbine isentropic efficiency
- eta = (h1 - h2,actual) / (h1 - h2,isentropic) x 100. h1 from inlet P and T; h2,actual from outlet P and T
  (only when the outlet is superheated); h2,isentropic is the outlet state with the same entropy as the inlet.
- Ideal work W = m x (h1 - h2,isentropic); actual work W = m x (h1 - h2,actual); m in kg/s = t/h / 3.6.
- HP section, inlet to 1st extraction (PT_103_1.PV, TE103.PV), measured on 16 Nov 2026: h1 3446.4,
  h2,actual 3215.1, h2,isentropic 3091.9 kJ/kg, so eta = 231.2 / 354.5 = 65.2 %. About 65 % is normal for the
  control stage of a small industrial turbine; a falling trend points to nozzle or blade wear or leakage.
- The whole-turbine efficiency cannot come from exhaust P and T: the exhaust is near saturation or wet, where
  temperature does not give the dryness. It needs an energy balance with every extraction flow.
- Losses: nozzle and blade friction, leakage through seals and clearances, partial admission, wetness in the
  last stages, bearings and coupling.

## Other effects (illustrative, condensing turbine example from the plant's notes, not this plant's data)
- Main steam temperature -10 C: about +1.1 % steam rate. Main steam pressure -5 ata: about +0.6 %.
  Worse exhaust pressure 0.10 to 0.12 ata: about +1.8 %. Exact corrections need the turbine maker's curves.

## Boiler: steam fuel ratio sheet
- X = (GCV - NCV) / GCV x 100; Y = 91 - X; Z = GCV x Y / 100; steam fuel ratio = Z / divisor.
- Divisor = 817 - economiser inlet feed water temperature (C); 667 at 150 C. 817 is roughly the main steam
  enthalpy in kcal/kg for about 87 ata / 510 C steam, so it should really be h_main - h_feedwater.
- The sheet's example has a typo: (2252.55 - 1776.14) / 2252.55 x 100 = 21.15 %, not 21.49 %. Y = 69.85 %,
  Z = 1573.40, ratio = 2.358 (truncated to three digits as the sheet says; exactly 2.3589).
- Bagasse per MWh = steam rate / steam fuel ratio (example: 5.76 / 2.358 = about 2.44 t/MWh). The two numbers
  come from different days, so this is only a sample calculation. GCV and NCV come from the lab.

## How to diagnose a high steam rate
1. Check load: low load raises steam rate by itself. Compare within the same load band.
2. Check main steam enthalpy (temperature first, then pressure). If enthalpy fell, the cause is on the
   boiler side: superheater temperature, desuperheater spray, firing, fouling.
3. If enthalpy is normal and the corrected steam rate is high, look at the turbine side: HP efficiency trend,
   extraction flows, exhaust back-pressure, leakage.
4. Check instruments: TT_07A/B/C disagreeing, or FT_02A and FT_02B drifting apart, point to a sensor, not the
   process. Steam flow should be pressure and temperature compensated.
5. Quantify each effect with the plant numbers above and say which part is explained and which is not.

## Units
- 1 kgf/cm2 = 0.980665 bar = 0.0980665 MPa; ata = gauge kgf/cm2 + 1.0332.
- 1 bar = 750.06 mmHg; 1 kcal = 4.1868 kJ; t/h / 3.6 = kg/s; MW x 1000 = kW.
