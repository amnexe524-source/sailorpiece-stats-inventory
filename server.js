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

  // ── GET /events — SSE ──
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

