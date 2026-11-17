# SteamRate

Works out plant performance tags from other tags and saves them in MongoDB the same way TrendToMongo saves
every other tag, so DCS Trends shows their live values, trends, daily summaries and CSV. It runs on the plant
PC next to TrendToMongo and uses TrendToMongo's `config.ini` and MongoDB driver (`lib\`).

| Tag | Worked out as | Unit | Saved |
| --- | --- | --- | --- |
| `STEAM_RATE.PV` | `FT_02A.PV / TG_LOAD.PV` (not below 1 MW) | TPH/MW | live and minute |
| `H_MS.PV` | Main steam enthalpy from `PT_02.PV`, `TT_07A.PV` (IAPWS-IF97; needs 15 °C of superheat) | kJ/kg | live and minute |
| `SR_CORR.PV` | `STEAM_RATE + 0.0019 × (H_MS − 3440) + 0.0221 × (TG_LOAD − 19.5)` (10 MW or more) | TPH/MW | live and minute |
| `DH_IS.PV` | Ideal (isentropic) enthalpy drop, main steam to exhaust `PT_106_1.PV` | kJ/kg | minute |
| `SR_IDEAL.PV` | `3600 / DH_IS`: steam rate of a loss-free turbine with no extraction | TPH/MW | minute |
| `HP_EFF.PV` | HP section isentropic efficiency, main steam to 1st extraction (`PT_103_1.PV`, `TE103.PV`) | % | minute |

Steam rate is set by the enthalpy **drop** through the turbine (steam rate = 3600 / Δh), not by inlet enthalpy
alone: lower inlet pressure or temperature and higher exhaust back-pressure both shrink the drop and raise the
steam rate. `DH_IS`, `SR_IDEAL` and `HP_EFF` are minute history only because their exhaust and extraction inputs
are not read live. The wet end of the expansion uses saturated liquid h ≈ 4.18 t and s ≈ 4.18 ln(T/273.15),
within about 2 kJ/kg at the exhaust (about 104 °C).

## What it writes (database `plant_trend`)

| Collection | What |
| --- | --- |
| `live_latest` | Live tags every second, newest two values, like the other live tags |
| `trend_minute` | One document per minute `{ t, tag, v }`, including all older history |
| `tag_info` | Description, unit and range of each tag |

It only adds documents for these six tags and updates their own live entries. It never deletes anything and
never changes another tag. A minute already saved is never written twice.

On start it fills every missing minute from the oldest `TG_LOAD.PV` history. Then every second it saves the live
values, and every minute it checks the last two days of history again, so minutes missed while it or the
internet was down are filled in. Times come from the database, so a wrong clock on the computer does not matter.

## Install on the plant PC

1. Copy `SteamRate.cs`, `Build.bat`, `Install-Task.ps1` and `Remove-Task.ps1` from this folder into
   `C:\Users\PAE\Desktop\TrendToMongo` (it already has `config.ini` and `lib\`).
2. Double-click `Build.bat`. It builds `SteamRate.exe` with the .NET Framework compiler that TrendToMongo uses.
3. As administrator, in PowerShell:
   ```powershell
   powershell -ExecutionPolicy Bypass -File "C:\Users\PAE\Desktop\TrendToMongo\Install-Task.ps1"
   ```
   It starts three minutes after PAE logs on and is checked every five minutes, like TrendToMongo.
4. Check `logs\SteamRate_<date>.log`: it should say `Live: saving ... every second`.

Run only one copy at a time (one per computer is enforced; do not run it on two computers).
Remove it with `Remove-Task.ps1`. Fill history once and stop: `SteamRate.exe --once`.

`config.ini` holds the database password. It stays on the plant PC and is never put in this repository.
