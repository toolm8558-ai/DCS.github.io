<p align="center"><img src="public/logo.png" alt="DCS Trends logo" width="110"></p>

<h1 align="center">DCS Trends</h1>

<p align="center">Live plant values and process history in the browser, on any screen.<br>
Read-only: this site can look at plant data but has no way to change it.</p>

---

## What it does

- **Live values at the top.** Key plant tags refresh on their own every 2 seconds, each with its current value, a short recent line and its position within the tag's range. The page says so clearly if live reading stops.
- **Pick any tag and any period.** Use a quick period (1 hour, 8 hours, today, yesterday, 7 days, 30 days) or set your own From and To, up to 31 days.
- **Average and total first.** The selected period's average, total, minimum, maximum and recorded share sit above the chart.
- **Trend chart.** Hover, tap or use the arrow keys to read any point. Gaps show when nothing was recorded.
- **Tables and export.** See a daily summary or every value, and download the period as CSV.
- **Works everywhere.** Responsive from phone to control-room screen, with light and dark views.

All dates and times are India time.

## How the data flows

```mermaid
flowchart LR
    A[Plant HMI<br>trend files and OPC] -->|TrendToMongo<br>reads only| B[(MongoDB Atlas<br>plant_trend)]
    B -->|DCS Trends server<br>reads only| C[Browser]
```

| Collection | Holds | Used for |
| --- | --- | --- |
| `trend_minute` | One value per tag per minute: `t`, `tag`, `v` | Trends, period figures, daily summary |
| `live_latest` | The newest readings of the live tags, updated every second | Live strip |
| `tag_info` | Description, unit, type and range of each tag | Search, labels, meters |
| `service_status` | Health of the recorder, including how recent the data is | Header |

History is saved about every 10 minutes, so it runs a little behind the live strip. On/off (BOOL) tags are not saved, so they have no trend and do not appear in search.

## How the numbers are worked out

For the period you select, using only the minutes that were recorded:

| Figure | Calculation |
| --- | --- |
| Average | Sum of the recorded values ÷ recorded minutes |
| Total | Average × recorded hours, for rate units only: t/h gives t, m3/h gives m3, MW gives MWh, kW gives kWh |
| Minimum, maximum | Lowest and highest recorded value, with the time it happened |
| Recorded | Recorded minutes ÷ minutes in the period so far |

If Recorded is below 100%, the total covers less than the full period and will read lower than the true amount. A negative total on t/h or m3/h counts as 0. Ranges over 3 days are drawn in about 2,000 points, each showing the average with a minimum and maximum band. The period's figures still use every minute.

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

### Deploy on Render

`render.yaml` describes the service. Create a Blueprint from this repository and enter `MONGO_URI` when asked; Render generates `ACCESS_KEY`, which you can copy from the service's Environment page. In Atlas, Network Access must allow the host to connect. After that, each push to `main` deploys by itself.

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

To show a trend inside another site, use `?embed=1`:

```html
<iframe src="https://your-site/?embed=1&tag=PT_02.PV" width="100%" height="900"></iframe>
```

## Security

- `server.js` only reads: it uses `find`, `findOne` and `aggregate`.
- Never commit `web.ini` or a connection string. This repository is public.
- Serve the site over https, because the access key travels with every request.
- Use a separate database user for the site, with the `read` role only.

## Project layout

```text
server.js         Web server and JSON API
public/           The site: index.html, app.js, logo and icon
render.yaml       Render deployment
package.json      Dependencies
```
