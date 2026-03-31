// =========================================================
//  INVENTORY SERVER — SSE Edition + Stats + Keep-Alive
//  node server.js
// =========================================================
const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const PORT      = 3000;
const HTML_FILE = path.join(__dirname, 'index.html');

let latestInventory = null;
let latestStats     = null;
let lastInvHash     = '';
let lastStatsHash   = '';
let lastReceived    = null;
let lastStatsReceived = null;

// ── Dungeon run persistence ──
let dungeonRuns = {
  thisRun:       null,
  lastRun:       null,
  towerMode:     false,
  towerDiff:     null,
  towerSnapshot: null,
  towerWave:     0
};

// ── Farm session persistence ──
let farmSession = {
  snapshot:  null,   // inventory snapshot ตอนเริ่ม farm
  diff:      null,   // diff สะสมตั้งแต่เริ่ม farm
  startTime: null,   // ISO timestamp ที่เริ่ม farm session
  active:    false   // กำลัง farm อยู่ไหม
};

const clients = new Set();

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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
  for (const res of clients) {
    try { res.write(msg); } catch {}
  }
  console.log(`[BROADCAST] → ${clients.size} client(s)`);
}

// Keep-Alive Ping
function pingRender() {
  https.get('https://sailorpiece-stats-inventory.onrender.com/', (res) => {
    console.log(`[PING] ${res.statusCode} - ${new Date().toISOString()}`);
    res.resume();
  }).on('error', (err) => {
    console.error(`[PING] Error: ${err.message}`);
  });
}
setInterval(pingRender, 5 * 60 * 1000);
pingRender();

// ── server ───────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  cors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204); return res.end();
  }

  // ── POST / — รับ Inventory จาก Lua ──
  if (req.method === 'POST' && req.url === '/') {
    try {
      const body = await readBody(req);
      const hash = crypto.createHash('md5').update(body).digest('hex');
      if (hash === lastInvHash) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, changed: false }));
      }
      const json      = JSON.parse(body);
      lastInvHash     = hash;
      latestInventory = json;
      lastReceived    = new Date().toISOString();
      console.log(`[INV] ✅ ข้อมูลใหม่ (${Buffer.byteLength(body)} bytes)`);
      broadcast({ type: 'inventory', inventory: json, lastReceived });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, changed: true }));
    } catch (e) {
      console.error('❌ Parse error:', e.message);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Bad JSON' }));
    }
  }

  // ── POST /stats — รับ Stats + Wave จาก Lua ──
  if (req.method === 'POST' && req.url === '/stats') {
    try {
      const body = await readBody(req);
      const hash = crypto.createHash('md5').update(body).digest('hex');
      if (hash === lastStatsHash) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, changed: false }));
      }
      const json          = JSON.parse(body);
      lastStatsHash       = hash;
      latestStats         = json;
      lastStatsReceived   = new Date().toISOString();
      console.log(`[STATS] ✅ ข้อมูลใหม่`);
      broadcast({ type: 'stats', stats: json, lastReceived: lastStatsReceived });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, changed: true }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Bad JSON' }));
    }
  }

  // ── GET /dungeon-runs — ดึงข้อมูล dungeon runs ──
  if (req.method === 'GET' && req.url === '/dungeon-runs') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(dungeonRuns));
  }

  // ── POST /dungeon-runs — บันทึก dungeon runs ──
  if (req.method === 'POST' && req.url === '/dungeon-runs') {
    try {
      const body = await readBody(req);
      const json = JSON.parse(body);
      // อัปเดตเฉพาะ field ที่ส่งมา (null ก็อัปเดตได้)
      if ('thisRun'       in json) dungeonRuns.thisRun       = json.thisRun;
      if ('lastRun'       in json) dungeonRuns.lastRun       = json.lastRun;
      if ('towerMode'     in json) dungeonRuns.towerMode     = json.towerMode     || false;
      if ('towerDiff'     in json) dungeonRuns.towerDiff     = json.towerDiff     || null;
      if ('towerSnapshot' in json) dungeonRuns.towerSnapshot = json.towerSnapshot || null;
      if ('towerWave'     in json) dungeonRuns.towerWave     = json.towerWave     || 0;
      console.log(`[DUNGEON] 💾 บันทึก runs (thisRun:${!!dungeonRuns.thisRun} lastRun:${!!dungeonRuns.lastRun} tower:${dungeonRuns.towerMode} wave:${dungeonRuns.towerWave})`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Bad JSON' }));
    }
  }

  // ── GET /farm-session — ดึงข้อมูล farm session ──
  if (req.method === 'GET' && req.url === '/farm-session') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(farmSession));
  }

  // ── POST /farm-session — บันทึก / อัปเดต farm session ──
  if (req.method === 'POST' && req.url === '/farm-session') {
    try {
      const body = await readBody(req);
      const json = JSON.parse(body);
      if (json.action === 'reset') {
        // รีเซ็ต session ใหม่ทั้งหมด
        farmSession = {
          snapshot:  json.snapshot  || null,
          diff:      null,
          startTime: new Date().toISOString(),
          active:    true
        };
        console.log('[FARM] 🔄 Reset farm session');
      } else if (json.action === 'start') {
        if (!farmSession.active) {
          farmSession.snapshot  = json.snapshot  || null;
          farmSession.diff      = null;
          farmSession.startTime = new Date().toISOString();
          farmSession.active    = true;
          console.log('[FARM] ▶ Start farm session');
        } else if (json.snapshot) {
          // อัปเดต snapshot ถ้ายังไม่มี (กรณี reconnect)
          if (!farmSession.snapshot) farmSession.snapshot = json.snapshot;
        }
      } else if (json.action === 'stop') {
        farmSession.active = false;
        console.log('[FARM] ⏹ Stop farm session');
      } else if (json.action === 'update') {
        // อัปเดต diff สะสม
        if ('diff' in json) farmSession.diff = json.diff;
        if ('snapshot' in json && json.snapshot && !farmSession.snapshot) {
          farmSession.snapshot = json.snapshot;
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, session: farmSession }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Bad JSON' }));
    }
  }


  if (req.method === 'GET' && req.url === '/events') {
    res.writeHead(200, {
      'Content-Type':      'text/event-stream',
      'Cache-Control':     'no-cache',
      'Connection':        'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // ส่งข้อมูลปัจจุบันทันทีเมื่อเชื่อมครั้งแรก
    if (latestInventory) {
      res.write(`data: ${JSON.stringify({ type:'inventory', inventory: latestInventory, lastReceived })}\n\n`);
    }
    if (latestStats) {
      res.write(`data: ${JSON.stringify({ type:'stats', stats: latestStats, lastReceived: lastStatsReceived })}\n\n`);
    }
    if (dungeonRuns.thisRun || dungeonRuns.lastRun || dungeonRuns.towerMode) {
      res.write(`data: ${JSON.stringify({
        type:          'dungeonRuns',
        thisRun:       dungeonRuns.thisRun,
        lastRun:       dungeonRuns.lastRun,
        towerMode:     dungeonRuns.towerMode,
        towerDiff:     dungeonRuns.towerDiff,
        towerSnapshot: dungeonRuns.towerSnapshot,
        towerWave:     dungeonRuns.towerWave
      })}\n\n`);
    }
    if (!latestInventory && !latestStats) {
      res.write(`: connected\n\n`);
    }

    clients.add(res);
    console.log(`[SSE] client เชื่อมต่อ (รวม ${clients.size})`);

    const hb = setInterval(() => {
      try { res.write(`: ping\n\n`); } catch {}
    }, 25000);

    req.on('close', () => {
      clients.delete(res);
      clearInterval(hb);
      console.log(`[SSE] client หลุด (เหลือ ${clients.size})`);
    });
    return;
  }

  // ── GET / — serve หน้าเว็บ ──
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    try {
      const html = fs.readFileSync(HTML_FILE, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    } catch {
      res.writeHead(404); return res.end('index.html not found');
    }
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   INVENTORY SERVER — SSE Edition!        ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║  Local  : http://localhost:${PORT}           ║`);
  console.log('╠══════════════════════════════════════════╣');
  console.log('║  POST /        ← Inventory จาก Lua        ║');
  console.log('║  POST /stats   ← Stats+Wave จาก Lua       ║');
  console.log('║  GET  /events  ← SSE push ไปเว็บ         ║');
  console.log('║  GET  /        ← หน้าเว็บ                 ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log('║  Keep-Alive Ping → sailorpiece-stats-inventory.onrender.com ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
});

