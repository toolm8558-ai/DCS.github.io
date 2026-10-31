'use strict';
// Read-only web server for the plant_trend database: serves the trend page and a JSON API.
// It only ever calls find and findOne: nothing here writes to MongoDB.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { MongoClient } = require('mongodb');

const IST = 330 * 60000, MINUTE = 60000, DAY = 1440 * MINUTE;
const KEEP_MINUTES = 60;      // every tag has a document at least this often while it is recording
const MAX_DAYS = 31, FULL_DETAIL_MINUTES = 4320, TARGET_POINTS = 2000;
const RATES = { 't/h': 't', 'm3/h': 'm3', MW: 'MWh', kW: 'kWh' };
const STATIC = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'] };

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

const dateOf = ms => new Date(ms + IST).toISOString().slice(0, 10);
const round = v => Math.round(v * 10000) / 10000;

function parseRange(query) {
  const from = parseIst(query.get('from'), 'from');
  let to = query.get('to') ? parseIst(query.get('to'), 'to') : from + DAY;
  if ((query.get('to') || '').length === 10) to += DAY;     // a date alone means the end of that day
  if (to <= from) throw new BadRequest('to must be after from');
  if (to - from > MAX_DAYS * DAY) throw new BadRequest(`The most that can be read at once is ${MAX_DAYS} days`);
  return { from, to };
}

// The first India-time hour after a moment, when every recording tag gets a document.
function nextHour(ms) {
  const hour = KEEP_MINUTES * MINUTE;
  return Math.floor((ms + IST) / hour) * hour + hour - IST;
}

// The hourly marks whose document never came, so the tag or the recorder stopped before them.
function missedHours(docs, latest) {
  const missed = new Set();
  docs.forEach((doc, i) => {
    const hour = nextHour(doc.t.getTime()), next = docs[i + 1];
    if (hour <= latest && (!next || next.t.getTime() > hour)) missed.add(hour);
  });
  return [...missed];
}

// Turns stored documents back into one row per minute. A minute with no document holds the value
// of the document before it, but only while the tag is known to be recording: the next document
// proves it, or lastSeen shows other tags were still being recorded in that hour, for the case
// where the recorder itself stopped before the hourly document was due. Minutes past the newest
// copied data stay empty. docs must reach an hour beyond the range both ways.
function expand(docs, from, minutes, latest, lastSeen) {
  const rows = new Array(minutes);
  let i = 0;
  for (let m = 0; m < minutes; m++) {
    const t = from + m * MINUTE;
    while (i < docs.length && docs[i].t.getTime() <= t) i++;
    const cur = docs[i - 1], next = docs[i];
    if (!cur) { rows[m] = null; continue; }
    const at = cur.t.getTime(), v = cur.v;
    if (at === t) {
      // The first minute after a recorder restart can hold a last value of 0 beside real min, max
      // and average. A last value outside its own minute's range cannot be real.
      const real = cur.min === undefined || (v >= cur.min && v <= cur.max) ? v : cur.avg;
      rows[m] = cur.min !== undefined ? { t, v: real, min: cur.min, max: cur.max, avg: cur.avg } : { t, v, min: v, max: v, avg: v };
      continue;
    }
    const hour = nextHour(at);
    const proven = next ? next.t.getTime() <= hour : false;
    const notYetDue = hour > latest && t <= latest;
    const stillRecording = t <= (lastSeen.get(hour) || 0);
    rows[m] = proven || notYetDue || stillRecording ? { t, v, min: v, max: v, avg: v } : null;
  }
  return rows;
}

function summarize(rows, info) {
  const s = { minutes: 0, source: 'minutes' };
  const isBool = info.type === 'BOOL';
  let sum = 0, on = 0, starts = 0, prev = null;
  for (const r of rows) {
    if (!r) continue;
    s.minutes++;
    sum += r.avg;
    if (s.min === undefined || r.min < s.min) { s.min = r.min; s.minAt = r.t; }
    if (s.max === undefined || r.max > s.max) { s.max = r.max; s.maxAt = r.t; }
    if (isBool) {
      if (r.v) on++;
      if (prev === 0 && r.v) starts++;
      prev = r.v;
    }
  }
  if (!s.minutes) return s;
  s.avg = round(sum / s.minutes);
  if (isBool) {
    s.hoursAt1 = round(on / 60);
    s.starts = starts;
  } else if (RATES[info.unit]) {
    let total = sum / 60;
    if ((info.unit === 't/h' || info.unit === 'm3/h') && total < 0) total = 0;
    s.total = round(total);
    s.totalUnit = RATES[info.unit];
  }
  return s;
}

// tag_daily was built from every minute with exact peak times, so whole days use it directly.
function combineDays(days) {
  const s = { minutes: 0, source: 'tag_daily', days: days.length };
  let weighted = 0, hasAvg = false;
  for (const d of days) {
    s.minutes += d.minutes;
    if (s.min === undefined || d.min < s.min) { s.min = d.min; s.minAt = d.minAt ? d.minAt.getTime() : undefined; s.minDate = d.date; }
    if (s.max === undefined || d.max > s.max) { s.max = d.max; s.maxAt = d.maxAt ? d.maxAt.getTime() : undefined; s.maxDate = d.date; }
    if (d.avg !== undefined) { weighted += d.avg * d.minutes; hasAvg = true; }
    if (d.total !== undefined) { s.total = round((s.total || 0) + d.total); s.totalUnit = d.totalUnit; }
    if (d.hoursAt1 !== undefined) { s.hoursAt1 = round((s.hoursAt1 || 0) + d.hoursAt1); s.starts = (s.starts || 0) + d.starts; }
  }
  if (hasAvg) s.avg = round(weighted / s.minutes);
  return s;
}

function bucketize(rows, size) {
  const out = [];
  for (let i = 0; i < rows.length; i += size) {
    const part = rows.slice(i, i + size).filter(Boolean);
    if (!part.length) { out.push({ gap: true }); continue; }
    out.push({
      t: part[0].t, v: part[part.length - 1].v,
      min: Math.min(...part.map(r => r.min)), max: Math.max(...part.map(r => r.max)),
      avg: round(part.reduce((a, r) => a + r.avg, 0) / part.length)
    });
  }
  return out;
}

async function main() {
  const cfg = loadConfig();
  const client = new MongoClient(cfg.uri, { maxPoolSize: 5, serverSelectionTimeoutMS: 15000 });
  await client.connect();
  const db = client.db(cfg.database);
  const minute = db.collection('trend_minute'), events = db.collection('bool_events');
  const daily = db.collection('tag_daily'), tags = db.collection('tag_info'), status = db.collection('service_status');

  async function tagInfo(name) {
    if (!name) throw new BadRequest('tag is required');
    const info = await tags.findOne({ _id: name });
    if (!info) throw new BadRequest(`Tag ${name} was not found`);
    return { tag: info._id, description: info.description, unit: info.unit, type: info.type, lo: info.lo, hi: info.hi };
  }

  function dayList(from, to) {
    const list = [];
    for (let t = from; t < to; t += DAY) list.push(dateOf(t));
    return list;
  }

  const routes = {
    async '/api/tags'(q) {
      const text = (q.get('q') || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const filter = text ? { $or: [{ _id: { $regex: text, $options: 'i' } }, { description: { $regex: text, $options: 'i' } }] } : {};
      const limit = Math.min(Number(q.get('limit')) || 30, 100);
      const list = await tags.find(filter).sort({ _id: 1 }).limit(limit).toArray();
      return list.map(t => ({ tag: t._id, description: t.description, unit: t.unit, type: t.type }));
    },

    async '/api/trend'(q) {
      const info = await tagInfo(q.get('tag'));
      const { from, to } = parseRange(q);
      const collection = info.type === 'BOOL' ? events : minute;
      const reach = KEEP_MINUTES * MINUTE;
      const [docs, health] = await Promise.all([
        collection.find({ tag: info.tag, t: { $gte: new Date(from - reach), $lte: new Date(to + reach) } }).sort({ t: 1 }).toArray(),
        status.findOne({})
      ]);
      const latest = health && health.newestData ? health.newestData.getTime() : Date.now();
      const minutes = Math.round((to - from) / MINUTE);
      const lastSeen = new Map(await Promise.all(missedHours(docs, latest).map(async hour => {
        const seen = await minute.find({ t: { $gte: new Date(hour - reach), $lt: new Date(hour) } }).sort({ t: -1 }).limit(1).toArray();
        return [hour, seen.length ? seen[0].t.getTime() : 0];
      })));
      const rows = expand(docs, from, minutes, latest, lastSeen);

      let summary = summarize(rows, info);
      const wholeDays = (from + IST) % DAY === 0 && (to + IST) % DAY === 0;
      if (wholeDays) {
        const found = await daily.find({ tag: info.tag, date: { $in: dayList(from, to) } }).toArray();
        if (found.length) summary = combineDays(found);
      }

      const bucketMinutes = minutes <= FULL_DETAIL_MINUTES ? 1 : Math.ceil(minutes / TARGET_POINTS);
      const points = bucketMinutes === 1
        ? rows.map((r, i) => r || { t: from + i * MINUTE })
        : bucketize(rows, bucketMinutes).map((p, i) => (p.gap ? { t: from + i * bucketMinutes * MINUTE } : p));
      return { ...info, from, to, requestedMinutes: minutes, bucketMinutes, summary, points };
    },

    async '/api/days'(q) {
      const info = await tagInfo(q.get('tag'));
      const { from, to } = parseRange(q);
      const days = await daily.find({ tag: info.tag, date: { $in: dayList(from, to) } }).sort({ date: -1 }).toArray();
      return { ...info, days: days.map(({ _id, tag, unit, type, ...d }) => ({ ...d, minAt: d.minAt && d.minAt.getTime(), maxAt: d.maxAt && d.maxAt.getTime() })) };
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
