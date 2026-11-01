'use strict';
// Read-only web server for the plant_trend database: serves the site and a JSON API.
// It only ever calls find, findOne and aggregate: nothing here writes to MongoDB.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { MongoClient } = require('mongodb');

const IST = 330 * 60000, MINUTE = 60000, DAY = 1440 * MINUTE;
const MAX_DAYS = 31, FULL_DETAIL_MINUTES = 4320, TARGET_POINTS = 2000;
const LIVE_CACHE_MS = 1000;   // live_latest changes once a second, however many people are watching
const RATES = { 't/h': 't', 'm3/h': 'm3', MW: 'MWh', kW: 'kWh' };
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/logo.png': ['logo.png', 'image/png'],
  '/favicon.png': ['favicon.png', 'image/png']
};

function loadConfig() {
  const file = {};
  const ini = path.join(__dirname, 'web.ini');
  if (fs.existsSync(ini)) {
    for (const raw of fs.readFileSync(ini, 'utf8').split(/\r?\n/)) {
      const line = raw.trim(), eq = line.indexOf('=');
      if (line && line[0] !== ';' && eq > 0) file[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
  }
  const cfg = {
    uri: process.env.MONGO_URI || file.MongoUri,
    database: process.env.DB_NAME || file.Database || 'plant_trend',
    key: process.env.ACCESS_KEY || file.AccessKey || '',
    port: Number(process.env.PORT || file.Port || 3000),
    host: process.env.HOST || file.Host || (process.env.PORT ? '0.0.0.0' : '127.0.0.1'),
    origin: process.env.ALLOWED_ORIGIN || file.AllowedOrigin || ''
  };
  if (!cfg.uri) throw new Error('Set MONGO_URI or MongoUri in web.ini');
  if (cfg.key.length < 16) throw new Error('Set ACCESS_KEY or AccessKey in web.ini, at least 16 characters');
  return cfg;
}

class BadRequest extends Error {}

// Dates in the API are India time: yyyy-MM-dd or yyyy-MM-ddTHH:mm.
function parseIst(text, name) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/.exec(text || '');
  if (!m) throw new BadRequest(`${name} must look like 2026-10-29 or 2026-10-29T10:00`);
  const utc = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
  const check = new Date(utc);
  if (check.getUTCMonth() !== +m[2] - 1 || check.getUTCDate() !== +m[3] || +(m[4] || 0) > 23 || +(m[5] || 0) > 59) throw new BadRequest(`${name} is not a real date`);
  return utc - IST;
}

const round = v => Math.round(v * 10000) / 10000;

function parseRange(query) {
  const from = parseIst(query.get('from'), 'from');
  let to = query.get('to') ? parseIst(query.get('to'), 'to') : from + DAY;
  if ((query.get('to') || '').length === 10) to += DAY;     // a date alone means the end of that day
  if (to <= from) throw new BadRequest('to must be after from');
  if (to - from > MAX_DAYS * DAY) throw new BadRequest(`The most that can be read at once is ${MAX_DAYS} days`);
  return { from, to };
}

// One slot per minute of the range. A minute with no document stays empty: the recorder has no
// value for it. An interrupted copy can leave a minute twice, and the slot keeps just one.
function toRows(docs, from, minutes) {
  const rows = new Array(minutes).fill(null);
  for (const doc of docs) {
    const m = Math.floor((doc.t.getTime() - from) / MINUTE);
    if (m >= 0 && m < minutes) rows[m] = { t: from + m * MINUTE, v: doc.v };
  }
  return rows;
}

// Flow and power tags are rates, so the amount over a time is the average rate times the hours.
function totalOf(avg, minutes, unit) {
  if (!RATES[unit]) return {};
  let total = avg * minutes / 60;
  if ((unit === 't/h' || unit === 'm3/h') && total < 0) total = 0;
  return { total: round(total), totalUnit: RATES[unit] };
}

function summarize(rows, info) {
  const s = { minutes: 0 };
  let sum = 0;
  for (const r of rows) {
    if (!r) continue;
    s.minutes++;
    sum += r.v;
    if (s.min === undefined || r.v < s.min) { s.min = r.v; s.minAt = r.t; }
    if (s.max === undefined || r.v > s.max) { s.max = r.v; s.maxAt = r.t; }
  }
  if (!s.minutes) return s;
  s.avg = round(sum / s.minutes);
  return { ...s, ...totalOf(sum / s.minutes, s.minutes, info.unit) };
}

function bucketize(rows, size) {
  const out = [];
  for (let i = 0; i < rows.length; i += size) {
    const part = rows.slice(i, i + size).filter(Boolean);
    if (!part.length) { out.push({ gap: true }); continue; }
    out.push({
      t: part[0].t, v: part[part.length - 1].v,
      min: Math.min(...part.map(r => r.v)), max: Math.max(...part.map(r => r.v)),
      avg: round(part.reduce((a, r) => a + r.v, 0) / part.length)
    });
  }
  return out;
}

async function main() {
  const cfg = loadConfig();
  const client = new MongoClient(cfg.uri, { maxPoolSize: 5, serverSelectionTimeoutMS: 15000 });
  await client.connect();
  const db = client.db(cfg.database);
  const minute = db.collection('trend_minute'), live = db.collection('live_latest');
  const tags = db.collection('tag_info'), status = db.collection('service_status');

  async function tagInfo(name) {
    if (!name) throw new BadRequest('tag is required');
    const info = await tags.findOne({ _id: name });
    if (!info) throw new BadRequest(`Tag ${name} was not found`);
    if (info.type === 'BOOL') throw new BadRequest(`${name} is an on/off tag. These are not saved, so it has no trend`);
    return { tag: info._id, description: info.description, unit: info.unit, type: info.type, lo: info.lo, hi: info.hi };
  }

  const liveInfo = new Map();
  let liveRead = null, liveReadAt = 0;

  async function readLive() {
    const docs = await live.find({}).sort({ _id: 1 }).toArray();
    const unknown = docs.map(d => d._id).filter(name => !liveInfo.has(name));
    if (unknown.length) for (const t of await tags.find({ _id: { $in: unknown } }).toArray()) liveInfo.set(t._id, t);
    return {
      now: Date.now(),
      tags: docs.filter(d => d.values && d.values.length).map(d => {
        const info = liveInfo.get(d._id) || {};
        return { tag: d._id, description: info.description, unit: d.unit, lo: info.lo, hi: info.hi, t: d.values[0].t.getTime(), v: d.values[0].v };
      })
    };
  }

  const routes = {
    async '/api/tags'(q) {
      const text = (q.get('q') || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const filter = { type: { $ne: 'BOOL' } };
      if (text) filter.$or = [{ _id: { $regex: text, $options: 'i' } }, { description: { $regex: text, $options: 'i' } }];
      const limit = Math.min(Number(q.get('limit')) || 30, 100);
      const list = await tags.find(filter).sort({ _id: 1 }).limit(limit).toArray();
      return list.map(t => ({ tag: t._id, description: t.description, unit: t.unit, type: t.type }));
    },

    async '/api/trend'(q) {
      const info = await tagInfo(q.get('tag'));
      const { from, to } = parseRange(q);
      const docs = await minute.find({ tag: info.tag, t: { $gte: new Date(from), $lt: new Date(to) } }, { projection: { _id: 0, t: 1, v: 1 } }).sort({ t: 1 }).toArray();
      const minutes = Math.round((to - from) / MINUTE);
      const rows = toRows(docs, from, minutes);
      const bucketMinutes = minutes <= FULL_DETAIL_MINUTES ? 1 : Math.ceil(minutes / TARGET_POINTS);
      const points = bucketMinutes === 1
        ? rows.map((r, i) => r || { t: from + i * MINUTE })
        : bucketize(rows, bucketMinutes).map((p, i) => (p.gap ? { t: from + i * bucketMinutes * MINUTE } : p));
      return { ...info, from, to, requestedMinutes: minutes, bucketMinutes, summary: summarize(rows, info), points };
    },

    async '/api/days'(q) {
      const info = await tagInfo(q.get('tag'));
      const { from, to } = parseRange(q);
      const days = await minute.aggregate([
        { $match: { tag: info.tag, t: { $gte: new Date(from), $lt: new Date(to) } } },
        { $group: {
          _id: { $dateToString: { date: '$t', format: '%Y-%m-%d', timezone: 'Asia/Kolkata' } },
          min: { $min: '$v' }, max: { $max: '$v' }, avg: { $avg: '$v' }, minutes: { $sum: 1 },
          minAt: { $top: { sortBy: { v: 1 }, output: '$t' } }, maxAt: { $top: { sortBy: { v: -1 }, output: '$t' } }
        } },
        { $sort: { _id: -1 } }
      ]).toArray();
      return {
        ...info,
        days: days.map(d => ({
          date: d._id, min: d.min, max: d.max, avg: round(d.avg), minutes: d.minutes,
          minAt: d.minAt.getTime(), maxAt: d.maxAt.getTime(), ...totalOf(d.avg, d.minutes, info.unit)
        }))
      };
    },

    '/api/live'() {
      if (!liveRead || Date.now() - liveReadAt >= LIVE_CACHE_MS) {
        liveReadAt = Date.now();
        liveRead = readLive().catch(e => { liveRead = null; throw e; });
      }
      return liveRead;
    },

    async '/api/status'() {
      return status.find({}).toArray();
    }
  };

  function allowed(req) {
    const given = Buffer.from(String(req.headers['x-api-key'] || ''));
    const want = Buffer.from(cfg.key);
    return given.length === want.length && crypto.timingSafeEqual(given, want);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    const send = (code, body, type = 'application/json; charset=utf-8') => {
      res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(body);
    };
    if (cfg.origin) {
      res.setHeader('Access-Control-Allow-Origin', cfg.origin);
      res.setHeader('Access-Control-Allow-Headers', 'x-api-key');
    }
    if (req.method === 'OPTIONS') return send(204, '');
    if (req.method !== 'GET') return send(405, JSON.stringify({ error: 'Only GET is supported' }));

    const asset = STATIC[url.pathname];
    if (asset) return send(200, fs.readFileSync(path.join(__dirname, 'public', asset[0])), asset[1]);

    const route = routes[url.pathname];
    if (!route) return send(404, JSON.stringify({ error: 'Not found' }));
    if (!allowed(req)) return send(401, JSON.stringify({ error: 'Wrong or missing access key' }));
    try {
      send(200, JSON.stringify(await route(url.searchParams)));
    } catch (e) {
      if (e instanceof BadRequest) return send(400, JSON.stringify({ error: e.message }));
      console.error(new Date().toISOString(), url.pathname, e.message);
      send(500, JSON.stringify({ error: 'The database could not be read' }));
    }
  });
  server.listen(cfg.port, cfg.host, () => console.log(`TrendWeb on http://${cfg.host}:${cfg.port}`));
}

main().catch(e => { console.error(e.message); process.exit(1); });
