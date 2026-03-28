// =========================================================
//  INVENTORY SERVER — SSE Edition
//  node server.js
// =========================================================
const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT      = 3000;
const HTML_FILE = path.join(__dirname, 'index.html');

let latestInventory = null;
let lastHash        = '';
let lastReceived    = null;

// SSE clients ที่เชื่อมอยู่
const clients = new Set();

// ── helpers ──────────────────────────────────────────────
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

// ส่ง SSE event ไปทุก client ที่เชื่อมอยู่
function broadcast(payload) {
  const msg = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    try { res.write(msg); } catch {}
  }
  console.log(`[BROADCAST] → ${clients.size} client(s)`);
}

// ── server ───────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  cors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204); return res.end();
  }

  // ── POST / — รับข้อมูลจาก Lua ──
  if (req.method === 'POST' && req.url === '/') {
    try {
      const body = await readBody(req);
      const hash = require('crypto').createHash('md5').update(body).digest('hex');

      // กรอง: ถ้าข้อมูลเหมือนเดิม ไม่ส่งต่อ
      if (hash === lastHash) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, changed: false }));
      }

      const json   = JSON.parse(body);
      lastHash        = hash;
      latestInventory = json;
      lastReceived    = new Date().toISOString();
      console.log(`[${lastReceived}] ✅ ข้อมูลใหม่ (${Buffer.byteLength(body)} bytes) → push ไปเว็บ`);

      // Push ทันทีเลย ไม่ต้องรอให้เว็บ poll
      broadcast({ inventory: json, lastReceived: lastReceived });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, changed: true }));
    } catch (e) {
      console.error('❌ Parse error:', e.message);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Bad JSON' }));
    }
  }

  // ── GET /events — SSE endpoint ──
  if (req.method === 'GET' && req.url === '/events') {
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // ส่งข้อมูลปัจจุบันทันทีเมื่อเชื่อมครั้งแรก
    if (latestInventory) {
      res.write(`data: ${JSON.stringify({ inventory: latestInventory, lastReceived })}\n\n`);
    } else {
      res.write(`: connected\n\n`);
    }

    clients.add(res);
    console.log(`[SSE] client เชื่อมต่อ (รวม ${clients.size})`);

    // Heartbeat ทุก 25 วิ กัน Render/proxy ตัดการเชื่อมต่อ
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
  console.log('║  POST /        ← Lua ส่งข้อมูลมาที่นี่   ║');
  console.log('║  GET  /events  ← SSE push ไปเว็บ         ║');
  console.log('║  GET  /        ← หน้าเว็บ Inventory       ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
});
