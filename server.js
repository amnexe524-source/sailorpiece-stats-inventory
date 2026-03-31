// =========================================================
//  INVENTORY SERVER — SSE + Google Firestore Persistence
//  node server.js
//
//  ENV vars required:
//    GOOGLE_PROJECT_ID        — your GCP project id
//    GOOGLE_CLIENT_EMAIL      — service account email
//    GOOGLE_PRIVATE_KEY       — service account private key (with \n)
// =========================================================
const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const PORT      = process.env.PORT || 3000;
const HTML_FILE = path.join(__dirname, 'index.html');

// ── Firestore REST helper ────────────────────────────────
// ใช้ Firestore REST API โดยตรง ไม่ต้องติดตั้ง @google-cloud/firestore
// เพื่อให้ deploy บน Render ได้ง่ายขึ้น

const PROJECT_ID    = process.env.GOOGLE_PROJECT_ID;
const CLIENT_EMAIL  = process.env.GOOGLE_CLIENT_EMAIL;
const PRIVATE_KEY   = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

// ── JWT / Access Token ───────────────────────────────────
let _accessToken    = null;
let _tokenExpiresAt = 0;

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (_accessToken && now < _tokenExpiresAt - 60) return _accessToken;

  const header  = base64url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const payload = base64url(Buffer.from(JSON.stringify({
    iss: CLIENT_EMAIL,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })));

  const sign = crypto.createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const sig = base64url(sign.sign(PRIVATE_KEY));
  const jwt = `${header}.${payload}.${sig}`;

  const tokenRes = await httpPost('https://oauth2.googleapis.com/token',
    'application/x-www-form-urlencoded',
    `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
  );

  _accessToken    = tokenRes.access_token;
  _tokenExpiresAt = now + 3600;
  return _accessToken;
}

// ── Generic HTTP helpers ─────────────────────────────────
function httpPost(url, contentType, body) {
  return new Promise((resolve, reject) => {
    const u    = new URL(url);
    const buf  = Buffer.from(body);
    const opts = {
      method:   'POST',
      hostname: u.hostname,
      path:     u.pathname + u.search,
      headers: {
        'Content-Type':   contentType,
        'Content-Length': buf.length,
      },
    };
    const req = https.request(opts, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
    });
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

function httpReq(method, url, token, body) {
  return new Promise((resolve, reject) => {
    const u   = new URL(url);
    const buf = body ? Buffer.from(JSON.stringify(body)) : null;
    const headers = {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
    };
    if (buf) headers['Content-Length'] = buf.length;

    const opts = { method, hostname: u.hostname, path: u.pathname + u.search, headers };
    const req  = https.request(opts, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    if (buf) req.write(buf);
    req.end();
  });
}

// ── Firestore document helpers ───────────────────────────
// Firestore เก็บ value ด้วย typed fields เช่น { stringValue: "..." }
// เราเก็บทุกอย่างเป็น JSON string ใน field "data" เพื่อความง่าย

function toFirestoreDoc(value) {
  return { fields: { data: { stringValue: JSON.stringify(value) } } };
}

function fromFirestoreDoc(doc) {
  if (!doc || !doc.fields || !doc.fields.data) return null;
  try { return JSON.parse(doc.fields.data.stringValue); }
  catch { return null; }
}

// ── DB Stats counters ────────────────────────────────────
const dbStats = {
  writes: 0,
  reads:  0,
  bytesWritten: 0,
  bytesRead:    0,
  lastWrite:    null,
  lastRead:     null,
};

async function fsSet(collection, docId, value) {
  try {
    const token = await getAccessToken();
    const url   = `${FIRESTORE_BASE}/${collection}/${docId}`;
    const body  = toFirestoreDoc(value);
    await httpReq('PATCH', url, token, body);
    dbStats.writes++;
    dbStats.bytesWritten += Buffer.byteLength(JSON.stringify(body));
    dbStats.lastWrite = new Date().toISOString();
  } catch (e) {
    console.error('[Firestore] set error:', e.message);
  }
}

async function fsGet(collection, docId) {
  try {
    const token = await getAccessToken();
    const url   = `${FIRESTORE_BASE}/${collection}/${docId}`;
    const doc   = await httpReq('GET', url, token, null);
    dbStats.reads++;
    dbStats.bytesRead += Buffer.byteLength(JSON.stringify(doc || {}));
    dbStats.lastRead = new Date().toISOString();
    return fromFirestoreDoc(doc);
  } catch {
    return null;
  }
}

// ── In-memory cache ──────────────────────────────────────
let latestInventory   = null;
let latestStats       = null;
let lastInvHash       = '';
let lastStatsHash     = '';
let lastReceived      = null;
let lastStatsReceived = null;

let dungeonRuns = {
  thisRun: null, lastRun: null,
  towerMode: false, towerDiff: null, towerSnapshot: null, towerWave: 0,
};

let farmSession = {
  snapshot: null, diff: null, startTime: null, active: false,
};

let uiConfig    = null;
let customIcons = {};

const clients = new Set();

// ── Boot: load from Firestore ────────────────────────────
async function bootLoad() {
  if (!PROJECT_ID || !CLIENT_EMAIL || !PRIVATE_KEY) {
    console.warn('[BOOT] ⚠️  Firestore env vars not set — running without persistence');
    return;
  }
  console.log('[BOOT] Loading state from Firestore...');
  try {
    const [inv, stats, dRuns, fSess, icons, cfg] = await Promise.all([
      fsGet('inventory', 'latest'),
      fsGet('stats',     'latest'),
      fsGet('dungeon',   'runs'),
      fsGet('farm',      'session'),
      fsGet('icons',     'all'),
      fsGet('config',    'ui'),
    ]);

    if (inv)   { latestInventory = inv.inventory; lastReceived      = inv.ts;    lastInvHash   = inv.hash   || ''; }
    if (stats) { latestStats     = stats.stats;   lastStatsReceived = stats.ts;  lastStatsHash = stats.hash || ''; }
    if (dRuns) { Object.assign(dungeonRuns, dRuns); }
    if (fSess) { Object.assign(farmSession, fSess); }
    if (icons) { customIcons = icons; console.log(`[BOOT] Loaded ${Object.keys(icons).length} custom icons`); }
    if (cfg)   { uiConfig = cfg; }
    console.log('[BOOT] Done ✓');
  } catch (e) {
    console.error('[BOOT] Error:', e.message);
  }
}

// ── Helpers ──────────────────────────────────────────────
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, ngrok-skip-browser-warning');
  res.setHeader('ngrok-skip-browser-warning',   'true');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end',  () => resolve(b));
    req.on('error', reject);
  });
}

function broadcast(payload) {
  const msg = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) { try { res.write(msg); } catch {} }
  console.log(`[BROADCAST] → ${clients.size} client(s)`);
}

function json200(res, data) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function json400(res, msg) {
  res.writeHead(400, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: msg }));
}

// Keep-Alive Ping (ป้องกัน Render sleep)
setInterval(() => {
  https.get('https://sailorpiece-stats-inventory.onrender.com/', r => r.resume())
    .on('error', () => {});
}, 5 * 60 * 1000);

// ── Server ───────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const url = req.url.split('?')[0];

  // POST / — รับ Inventory จาก Lua
  if (req.method === 'POST' && url === '/') {
    try {
      const body = await readBody(req);
      const hash = crypto.createHash('md5').update(body).digest('hex');
      if (hash === lastInvHash) return json200(res, { ok: true, changed: false });
      const parsed    = JSON.parse(body);
      lastInvHash     = hash;
      latestInventory = parsed;
      lastReceived    = new Date().toISOString();
      console.log(`[INV] ✅ ${Buffer.byteLength(body)} bytes`);
      broadcast({ type: 'inventory', inventory: parsed, lastReceived });
      fsSet('inventory', 'latest', { inventory: parsed, ts: lastReceived, hash }).catch(() => {});
      return json200(res, { ok: true, changed: true });
    } catch { return json400(res, 'Bad JSON'); }
  }

  // POST /stats — รับ Stats จาก Lua
  if (req.method === 'POST' && url === '/stats') {
    try {
      const body = await readBody(req);
      const hash = crypto.createHash('md5').update(body).digest('hex');
      if (hash === lastStatsHash) return json200(res, { ok: true, changed: false });
      const parsed        = JSON.parse(body);
      lastStatsHash       = hash;
      latestStats         = parsed;
      lastStatsReceived   = new Date().toISOString();
      broadcast({ type: 'stats', stats: parsed, lastReceived: lastStatsReceived });
      fsSet('stats', 'latest', { stats: parsed, ts: lastStatsReceived, hash }).catch(() => {});
      return json200(res, { ok: true, changed: true });
    } catch { return json400(res, 'Bad JSON'); }
  }

  // GET /dungeon-runs
  if (req.method === 'GET' && url === '/dungeon-runs') {
    return json200(res, dungeonRuns);
  }

  // POST /dungeon-runs
  if (req.method === 'POST' && url === '/dungeon-runs') {
    try {
      const j = JSON.parse(await readBody(req));
      if ('thisRun'       in j) dungeonRuns.thisRun       = j.thisRun;
      if ('lastRun'       in j) dungeonRuns.lastRun       = j.lastRun;
      if ('towerMode'     in j) dungeonRuns.towerMode     = j.towerMode     || false;
      if ('towerDiff'     in j) dungeonRuns.towerDiff     = j.towerDiff     || null;
      if ('towerSnapshot' in j) dungeonRuns.towerSnapshot = j.towerSnapshot || null;
      if ('towerWave'     in j) dungeonRuns.towerWave     = j.towerWave     || 0;
      fsSet('dungeon', 'runs', dungeonRuns).catch(() => {});
      return json200(res, { ok: true });
    } catch { return json400(res, 'Bad JSON'); }
  }

  // GET /farm-session
  if (req.method === 'GET' && url === '/farm-session') {
    return json200(res, farmSession);
  }

  // POST /farm-session
  if (req.method === 'POST' && url === '/farm-session') {
    try {
      const j = JSON.parse(await readBody(req));
      if (j.action === 'reset') {
        farmSession = { snapshot: j.snapshot || null, diff: null, startTime: new Date().toISOString(), active: true };
      } else if (j.action === 'start') {
        if (!farmSession.active) {
          farmSession = { snapshot: j.snapshot || null, diff: null, startTime: new Date().toISOString(), active: true };
        } else if (j.snapshot && !farmSession.snapshot) {
          farmSession.snapshot = j.snapshot;
        }
      } else if (j.action === 'stop') {
        farmSession.active = false;
      } else if (j.action === 'update') {
        if ('diff'     in j) farmSession.diff     = j.diff;
        if ('snapshot' in j && j.snapshot && !farmSession.snapshot) farmSession.snapshot = j.snapshot;
      }
      fsSet('farm', 'session', farmSession).catch(() => {});
      return json200(res, { ok: true, session: farmSession });
    } catch { return json400(res, 'Bad JSON'); }
  }

  // GET /config
  if (req.method === 'GET' && url === '/config') {
    const cfg = uiConfig || await fsGet('config', 'ui');
    return json200(res, cfg || {});
  }

  // POST /config
  if (req.method === 'POST' && url === '/config') {
    try {
      const j = JSON.parse(await readBody(req));
      uiConfig = j;
      fsSet('config', 'ui', j).catch(() => {});
      return json200(res, { ok: true });
    } catch { return json400(res, 'Bad JSON'); }
  }

  // GET /icons
  if (req.method === 'GET' && url === '/icons') {
    return json200(res, customIcons);
  }

  // POST /icons
  if (req.method === 'POST' && url === '/icons') {
    try {
      const j = JSON.parse(await readBody(req));
      if (!j.name || !j.url)             return json400(res, 'name and url required');
      if (!/^https?:\/\//i.test(j.url))  return json400(res, 'invalid url');
      customIcons[j.name] = j.url;
      fsSet('icons', 'all', customIcons).catch(() => {});
      broadcast({ type: 'customIcon', name: j.name, url: j.url });
      console.log(`[ICON] ➕ "${j.name}" → ${j.url}`);
      return json200(res, { ok: true });
    } catch { return json400(res, 'Bad JSON'); }
  }

  // DELETE /icons
  if (req.method === 'DELETE' && url === '/icons') {
    try {
      const j = JSON.parse(await readBody(req));
      if (!j.name) return json400(res, 'name required');
      delete customIcons[j.name];
      fsSet('icons', 'all', customIcons).catch(() => {});
      broadcast({ type: 'iconDeleted', name: j.name });
      return json200(res, { ok: true });
    } catch { return json400(res, 'Bad JSON'); }
  }

  // GET /events — SSE
  if (req.method === 'GET' && url === '/events') {
    res.writeHead(200, {
      'Content-Type':      'text/event-stream',
      'Cache-Control':     'no-cache',
      'Connection':        'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    if (latestInventory)  res.write(`data: ${JSON.stringify({ type: 'inventory', inventory: latestInventory, lastReceived })}\n\n`);
    if (latestStats)      res.write(`data: ${JSON.stringify({ type: 'stats', stats: latestStats, lastReceived: lastStatsReceived })}\n\n`);
    if (dungeonRuns.thisRun || dungeonRuns.lastRun || dungeonRuns.towerMode)
      res.write(`data: ${JSON.stringify({ type: 'dungeonRuns', ...dungeonRuns })}\n\n`);
    if (Object.keys(customIcons).length)
      res.write(`data: ${JSON.stringify({ type: 'allIcons', icons: customIcons })}\n\n`);
    if (!latestInventory && !latestStats) res.write(`: connected\n\n`);

    clients.add(res);
    console.log(`[SSE] +client (total ${clients.size})`);

    const hb = setInterval(() => { try { res.write(`: ping\n\n`); } catch {} }, 25000);
    req.on('close', () => { clients.delete(res); clearInterval(hb); console.log(`[SSE] -client (total ${clients.size})`); });
    return;
  }

  // GET / — serve หน้าเว็บ
  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    try {
      const html = fs.readFileSync(HTML_FILE, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    } catch { res.writeHead(404); return res.end('index.html not found'); }
  }

  // GET /db-stats — สถิติการใช้ Firestore
  if (req.method === 'GET' && url === '/db-stats') {
    return json200(res, dbStats);
  }

  res.writeHead(404); res.end('Not found');
});

// ── Boot ─────────────────────────────────────────────────
bootLoad().then(() => {
  server.listen(PORT, () => {
    console.log('');
    console.log('╔══════════════════════════════════════════╗');
    console.log('║   INVENTORY SERVER — Firestore Edition    ║');
    console.log('╠══════════════════════════════════════════╣');
    console.log(`║  http://localhost:${PORT}                    ║`);
    console.log('╠══════════════════════════════════════════╣');
    console.log('║  POST /          ← Inventory (Lua)        ║');
    console.log('║  POST /stats     ← Stats+Wave (Lua)       ║');
    console.log('║  GET  /events    ← SSE push               ║');
    console.log('║  GET|POST /config ← UI Config             ║');
    console.log('║  GET|POST|DELETE /icons ← Custom Icons    ║');
    console.log('║  GET  /db-stats  ← Firestore usage stats  ║');
    console.log('╚══════════════════════════════════════════╝');
    console.log('');
  });
});
