'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');

const PORT = Number(process.env.PORT) || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || APP_PASSWORD;
const COOKIE = 'mealprep_session';
const MAX_BATCHES = 1000;

/* ---------- validation ---------- */

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function clampInt(v, lo, hi) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
}

function normalize(id, b) {
  b = b || {};
  const total = clampInt(b.total, 1, 99);
  const tags = Array.isArray(b.tags)
    ? [...new Set(b.tags.filter((t) => typeof t === 'string').map((t) => t.trim().slice(0, 24)).filter(Boolean))].slice(0, 12)
    : [];
  return {
    id,
    name: String(b.name || '').trim().slice(0, 80),
    cooked: DAY_RE.test(b.cooked) ? b.cooked : new Date().toISOString().slice(0, 10),
    total,
    left: clampInt(b.left, 0, total),
    storage: b.storage === 'freezer' ? 'freezer' : 'fridge',
    tags,
    created: Number(b.created) || Date.now(),
  };
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/* ---------- storage: local SQLite file ---------- */

// On Railway, attach a volume and the database lives on it (RAILWAY_VOLUME_MOUNT_PATH is set
// automatically). Without a volume the file is wiped on every deploy.
const DB_PATH = process.env.DATABASE_PATH
  || path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data'), 'mealprep.db');

function sqliteStore(file) {
  const { DatabaseSync } = require('node:sqlite');
  let db, q;
  const row = (r) => ({
    id: r.id, name: r.name, cooked: r.cooked, total: r.total, left: r.left_count,
    storage: r.storage, tags: JSON.parse(r.tags), created: r.created,
  });
  return {
    kind: 'sqlite',
    file,
    async init() {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      db = new DatabaseSync(file);
      db.exec(`PRAGMA journal_mode = WAL;
        PRAGMA busy_timeout = 5000;
        CREATE TABLE IF NOT EXISTS batches (
          id text PRIMARY KEY,
          name text NOT NULL,
          cooked text NOT NULL,
          total integer NOT NULL,
          left_count integer NOT NULL,
          storage text NOT NULL,
          tags text NOT NULL DEFAULT '[]',
          created integer NOT NULL,
          updated_at text NOT NULL DEFAULT (datetime('now'))
        )`);
      q = {
        list: db.prepare('SELECT * FROM batches ORDER BY cooked, created'),
        get: db.prepare('SELECT * FROM batches WHERE id = ?'),
        count: db.prepare('SELECT count(*) AS n FROM batches'),
        put: db.prepare(`INSERT INTO batches (id, name, cooked, total, left_count, storage, tags, created)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (id) DO UPDATE SET name = excluded.name, cooked = excluded.cooked, total = excluded.total,
            left_count = excluded.left_count, storage = excluded.storage, tags = excluded.tags, updated_at = datetime('now')
          RETURNING *`),
        adjust: db.prepare(`UPDATE batches SET left_count = MIN(total, MAX(0, left_count + ?)), updated_at = datetime('now')
          WHERE id = ? RETURNING *`),
        remove: db.prepare('DELETE FROM batches WHERE id = ?'),
        ping: db.prepare('SELECT 1'),
      };
    },
    async list() { return q.list.all().map(row); },
    async exists(id) { return !!q.get.get(id); },
    async count() { return q.count.get().n; },
    async put(b) {
      return row(q.put.get(b.id, b.name, b.cooked, b.total, b.left, b.storage, JSON.stringify(b.tags), b.created));
    },
    async adjust(id, delta) {
      const r = q.adjust.get(delta, id);
      return r ? row(r) : null;
    },
    async remove(id) { q.remove.run(id); },
    async ping() { q.ping.get(); },
    close() { if (db) db.close(); },
  };
}

const store = sqliteStore(DB_PATH);

/* ---------- auth (optional shared password) ---------- */

const token = () => crypto.createHmac('sha256', SESSION_SECRET).update('mealprep:v1:' + APP_PASSWORD).digest('base64url');

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

const isAuthed = (req) => !APP_PASSWORD || safeEqual(readCookie(req, COOKIE) || '', token());

function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  res.status(401).json({ error: 'unauthorized' });
}

// Small in-memory throttle on password attempts, per client IP.
const attempts = new Map();
function throttled(ip) {
  const now = Date.now();
  const a = attempts.get(ip) || { n: 0, until: 0, first: now };
  if (now - a.first > 15 * 60 * 1000) Object.assign(a, { n: 0, first: now });
  attempts.set(ip, a);
  return a;
}

/* ---------- app ---------- */

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

app.get('/healthz', async (req, res) => {
  try {
    await store.ping();
    res.json({ ok: true, store: store.kind });
  } catch (e) {
    res.status(503).json({ ok: false });
  }
});

app.get('/api/session', (req, res) => {
  res.json({ authRequired: !!APP_PASSWORD, authed: isAuthed(req) });
});

app.post('/api/login', (req, res) => {
  if (!APP_PASSWORD) return res.json({ ok: true });
  const a = throttled(req.ip);
  if (a.until > Date.now()) return res.status(429).json({ error: 'too_many_attempts' });
  if (!safeEqual(String((req.body && req.body.password) || ''), APP_PASSWORD)) {
    a.n += 1;
    if (a.n >= 10) a.until = Date.now() + 15 * 60 * 1000;
    return res.status(401).json({ error: 'wrong_password' });
  }
  attempts.delete(req.ip);
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${token()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}`);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
});

const api = express.Router();
api.use(requireAuth);

api.get('/batches', async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ batches: await store.list() });
  } catch (e) { next(e); }
});

api.put('/batches/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!ID_RE.test(id)) return res.status(400).json({ error: 'bad_id' });
    const b = normalize(id, req.body);
    if (!b.name) return res.status(400).json({ error: 'name_required' });
    if (!(await store.exists(id)) && (await store.count()) >= MAX_BATCHES) {
      return res.status(507).json({ error: 'quota_exceeded' });
    }
    res.json({ batch: await store.put(b) });
  } catch (e) { next(e); }
});

api.post('/batches/:id/adjust', async (req, res, next) => {
  try {
    const delta = clampInt(req.body && req.body.delta, -99, 99);
    if (!ID_RE.test(req.params.id) || !delta) return res.status(400).json({ error: 'bad_request' });
    const b = await store.adjust(req.params.id, delta);
    if (!b) return res.status(404).json({ error: 'not_found' });
    res.json({ batch: b });
  } catch (e) { next(e); }
});

api.delete('/batches/:id', async (req, res, next) => {
  try {
    if (!ID_RE.test(req.params.id)) return res.status(400).json({ error: 'bad_id' });
    await store.remove(req.params.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.use('/api', api);
app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, file) {
    if (file.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  },
}));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'server_error' });
});

store.init().then(() => {
  const server = app.listen(PORT, () => {
    console.log(`Meal prep listening on :${PORT} (database: ${store.file}, password: ${APP_PASSWORD ? 'on' : 'off'})`);
  });
  const shutdown = () => server.close(() => { store.close(); process.exit(0); });
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}).catch((e) => {
  console.error('Failed to initialise storage:', e);
  process.exit(1);
});
