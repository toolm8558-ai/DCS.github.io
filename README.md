<p align="center"><img src="public/logo.png" alt="DCS Trends logo" width="110"></p>

<h1 align="center">DCS Trends</h1>

<p align="center">Live plant values, process history and turbine performance in the browser, on any screen.<br>
The site only reads plant data; it has no way to change it.</p>

---

## What it does

- **Live values.** Key plant tags refresh every 2 seconds as cards with the current value, the change since the page opened and a short recent line. The steam rate leads. The page says so clearly if live reading stops.
- **Live limits.** Each person can set a high or low limit on any live value; a card past its limit turns red, within it green. Limits are kept in that person's browser.
- **Any tag, any period.** Search a tag, pick 1H, 8H, Today, Yesterday, 7D, 30D or a custom range up to 31 days. The trend shows the last value and its change, a chart coloured by direction, a low-to-high bar, a period summary, a daily table, every value and a CSV download.
- **Menu pages** (open the menu from the DCS Trends logo; each page has its own address, so Back, refresh and links work):
  - **Turbine performance** (`#/performance`): live main steam enthalpy, steam rate, corrected steam rate, ideal enthalpy drop and HP efficiency; steam rate against the enthalpy drop (or inlet enthalpy) for every minute on load, coloured by load, with the plant fit; corrected against actual steam rate over time.
  - **Compare tags** (`#/compare`): up to 6 tags on one time axis, each on its own scale with one crosshair, an overlay of up to 3 tags as % of their range, and a min, average, max and last table.
  - **Enthalpy calculator** (`#/enthalpy`): main steam enthalpy worked out step by step from live pressure and temperature with IAPWS-IF97, and the HP section isentropic efficiency.
  - **Live limits** (`#/limits`).
- **AI assistant.** Ask about live values, trends, steam rate, enthalpy or efficiency by typing or by voice (English or Hindi). It reads plant data through read-only tools and the plant knowledge in `assistant-knowledge.md`, shows its working, and never gives operating commands or setpoints.
- **Works everywhere.** From phone to control-room screen, in light and dark views.

All dates and times are India time.

## How the data flows

```mermaid
flowchart LR
    A[Plant HMI<br>trend files and OPC] -->|TrendToMongo<br>reads only| B[(MongoDB Atlas<br>plant_trend)]
    B -->|SteamRate<br>performance tags| B
    B -->|DCS Trends server<br>reads only| C[Browser]
    C -->|questions| D[AI assistant<br>OpenRouter]
```

| Collection | Holds | Used for |
| --- | --- | --- |
| `trend_minute` | One value per tag per minute: `t`, `tag`, `v` | Trends, period figures, daily summary |
| `live_latest` | The newest readings of the live tags, updated every second | Live values |
| `tag_info` | Description, unit, type and range of each tag | Search, labels |
| `service_status` | Health of the recorder, including how recent the data is | Header |

History is saved about every 10 minutes, so it runs a little behind the live values. On/off (BOOL) tags are not saved, so they have no trend and do not appear in search.

### Performance tags

[`steamrate/`](steamrate/) holds SteamRate, a small program that runs on the plant PC next to TrendToMongo and saves these tags from the others, with all older history:

| Tag | Meaning | Unit |
| --- | --- | --- |
| `STEAM_RATE.PV` | `FT_02A.PV / TG_LOAD.PV` | TPH/MW |
| `H_MS.PV` | Main steam enthalpy (IAPWS-IF97) | kJ/kg |
| `SR_CORR.PV` | Steam rate corrected to 3440 kJ/kg and 19.5 MW | TPH/MW |
| `DH_IS.PV` | Ideal enthalpy drop, main steam to exhaust | kJ/kg |
| `SR_IDEAL.PV` | `3600 / DH_IS` | TPH/MW |
| `HP_EFF.PV` | HP section isentropic efficiency | % |

Steam rate is set by the enthalpy drop through the turbine (steam rate = 3600 / Δh): it rises when main steam pressure or temperature falls, when exhaust back-pressure rises, or when the turbine wears. See [`steamrate/README.md`](steamrate/README.md) to install it.

## How the numbers are worked out

For the period you select, using only the minutes that were recorded:

| Figure | Calculation |
| --- | --- |
| Average | Sum of the recorded values ÷ recorded minutes |
| Total | Average × recorded hours, for rate units only: t/h gives t, m3/h gives m3, MW gives MWh, kW gives kWh |
| Minimum, maximum | Lowest and highest recorded value, with the time it happened |
| Recorded | Recorded minutes ÷ minutes in the period so far |

If Recorded is below 100%, the total covers less than the full period and will read lower than the true amount. A negative total on t/h or m3/h counts as 0. Ranges over 3 days are drawn in about 2,000 points, each showing the average with a minimum and maximum band. The period's figures still use every minute.

Steam properties use IAPWS-IF97 (`public/if97.js`, shared by the browser and the server), checked against the standard's test values and steam tables for superheated steam up to 10 MPa.

## Run it

You need Node.js 20 or newer, and a MongoDB user with the `read` role on `plant_trend`.

```bash
npm install
MONGO_URI="mongodb+srv://USER:PASSWORD@HOST/" ACCESS_KEY="a-long-random-key" node server.js
```

Then open <http://127.0.0.1:3000> and enter the access key. On a Windows computer you can put the same settings in a `web.ini` file instead (see `.gitignore`: it is never committed).

| Setting | Required | Meaning |
| --- | --- | --- |
| `MONGO_URI` | Yes | Connection string of a read-only database user |
| `ACCESS_KEY` | Yes | Key people enter to open the site, at least 16 characters |
| `DB_NAME` | No | Database name, `plant_trend` by default |
| `ALLOWED_ORIGIN` | No | Another site allowed to call the API from a browser |
| `OPENROUTER_API_KEY` | For the AI | OpenRouter key for the assistant; `OPENROUTER_API_KEY_FALLBACK` is tried if it fails |
| `OPENROUTER_MODEL` | No | Model for the assistant, `openrouter/auto` by default |

### Deploy on Render

`render.yaml` describes the service. Create a Blueprint from this repository and enter `MONGO_URI` and the OpenRouter keys when asked; Render generates `ACCESS_KEY`, which you can copy from the service's Environment page. In Atlas, Network Access must allow the host to connect. After that, each push to `main` deploys by itself.

### Open it from GitHub Pages

The site's pages can also be opened from <https://toolm8558-ai.github.io/DCS.github.io/>. Each push that changes `public/` publishes them through `.github/workflows/pages.yml`. In the repository, Settings, Pages, Source must be set to GitHub Actions.

GitHub Pages only serves files, so the server on Render must keep running: the database password has to stay on a server, never in the browser. The pages call `https://dcs-trendweb.onrender.com`, which allows them through `ALLOWED_ORIGIN`.

## API

Send the key in the `x-api-key` header. Requests without it get `401`. Call the API from your own server rather than putting the key in a public web page.

| Request | Returns |
| --- | --- |
| `GET /api/live` | Latest value of each live tag |
| `GET /api/tags?q=steam` | Tags matching a name or description |
| `GET /api/trend?tag=PT_02.PV&from=2026-10-29T10:00&to=2026-10-29T12:00` | Period figures in `summary` and values in `points`. A date with no time means the whole day |
| `GET /api/days?tag=PT_02.PV&from=2026-10-01&to=2026-10-30` | One row per day |
| `GET /api/status` | Recorder health |
| `POST /api/assistant` | AI assistant reply to `{ messages, dashboard }` |

To show a trend inside another site, use `?embed=1`:

```html
<iframe src="https://your-site/?embed=1&tag=PT_02.PV" width="100%" height="900"></iframe>
```

## Security

- `server.js` only reads: it uses `find`, `findOne` and `aggregate`. The AI assistant's tools are read-only too.
- SteamRate writes only its own six tags, with TrendToMongo's database user, on the plant PC.
- Never commit `web.ini`, `config.ini` or a connection string. This repository is public.
- Serve the site over https, because the access key travels with every request.
- Use a separate database user for the site, with the `read` role only.

## Project layout

```text
server.js               Web server, JSON API and AI assistant tools
assistant-knowledge.md  Plant knowledge given to the AI assistant
public/                 The site
  index.html            Page and styles
  app.js                Live values, limits, search and trend
  tools.js              Menu, pages, Turbine performance and Compare tags
  enthalpy.js           Enthalpy calculator page
  if97.js               IAPWS-IF97 steam properties (browser and server)
  assistant.js          AI assistant chat and voice input
steamrate/              SteamRate program for the plant PC (source, build and install scripts)
render.yaml             Render deployment
package.json            Dependencies
```
