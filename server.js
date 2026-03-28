// =========================================================
//  INVENTORY SERVER — รันบน Termux
//  node server.js
// =========================================================
const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT      = 3000;
const HTML_FILE = path.join(__dirname, 'index.html');

// เก็บข้อมูลล่าสุดที่ Lua ส่งมา
let latestInventory = null;
let lastReceived    = null;

// ── helpers ──────────────────────────────────────────────
function corsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, ngrok-skip-browser-warning');
  res.setHeader('ngrok-skip-browser-warning',   'true');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end',  () => resolve(body));
    req.on('error', reject);
  });
}

// ── server ───────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  corsHeaders(res);

  // Pre-flight CORS
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // POST /  — รับข้อมูลจาก Lua
  if (req.method === 'POST' && req.url === '/') {
    try {
      const body = await readBody(req);
      const json = JSON.parse(body);
      latestInventory = json;
      lastReceived    = new Date().toISOString();
      console.log(`[${lastReceived}] ✅ รับข้อมูลจาก Lua (${Buffer.byteLength(body)} bytes)`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      console.error('❌ Parse error:', e.message);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Bad JSON' }));
    }
  }

  // GET /data  — ส่งข้อมูลล่าสุดให้เว็บ
  if (req.method === 'GET' && req.url === '/data') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (!latestInventory) {
      return res.end(JSON.stringify({}));
    }
    return res.end(JSON.stringify({
      inventory:    latestInventory,
      lastReceived: lastReceived
    }));
  }

  // GET /  — serve หน้าเว็บ
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    try {
      const html = fs.readFileSync(HTML_FILE, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    } catch {
      res.writeHead(404);
      return res.end('index.html not found');
    }
  }

  // 404
  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   INVENTORY SERVER — พร้อมใช้งานแล้ว!   ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║  Local  : http://localhost:${PORT}           ║`);
  console.log('║  ngrok  : ดู URL ที่ terminal ngrok       ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log('║  POST /       ← Lua ส่งข้อมูลมาที่นี่    ║');
  console.log('║  GET  /data   ← เว็บดึงข้อมูลจากนี่      ║');
  console.log('║  GET  /       ← หน้าเว็บ Inventory        ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
});
