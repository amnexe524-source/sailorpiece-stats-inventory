// =========================================================
//  INVENTORY SERVER — SSE Edition + Stats + Database + Webhook
//  node server.js
//  (ติดตั้งเพิ่ม: npm install sqlite3)
// =========================================================
const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const PORT      = 3000;
const HTML_FILE = path.join(__dirname, 'index.html');

// ── DISCORD WEBHOOK CONFIG ──
// ใส่ Webhook URL ของแคลนที่นี่
const DISCORD_WEBHOOK_URL = ''; 

let latestInventory = null;
let latestNormalized= null;
let latestStats     = null;
let lastInvHash     = '';
let lastStatsHash   = '';
let lastReceived    = null;
let lastStatsReceived = null;

// ── Dungeon run persistence ──
let dungeonRuns = { thisRun: null, lastRun: null };

const clients = new Set();

// ── SQLITE DATABASE SETUP (Optional/Graceful Degradation) ──
let db = null;
try {
  const sqlite3 = require('sqlite3').verbose();
  db = new sqlite3.Database(path.join(__dirname, 'database.sqlite'), (err) => {
    if (err) console.error('[⚠️ DB] ไม่สามารถเปิดฐานข้อมูลได้:', err.message);
    else console.log('[💾 DB] เชื่อมต่อ SQLite Database สำเร็จ');
  });
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS dungeon_runs (id INTEGER PRIMARY KEY, data TEXT)`);
    // โหลดข้อมูลเก่ากลับมา
    db.get(`SELECT data FROM dungeon_runs WHERE id = 1`, (err, row) => {
      if (row) {
        try {
          dungeonRuns = JSON.parse(row.data);
          console.log('[💾 DB] ดึงข้อมูล Dungeon Runs จาก Database แล้ว');
        } catch(e){}
      }
    });
  });
} catch(err) {
  console.log('[⚠️ DB] ไม่พบ module sqlite3 จะเก็บข้อมูลแค่ใน Memory (หากต้องการให้พิมพ์: npm install sqlite3)');
}

function saveDungeonRunsToDB() {
  if (db) {
    db.run(`INSERT OR REPLACE INTO dungeon_runs (id, data) VALUES (1, ?)`, [JSON.stringify(dungeonRuns)]);
  }
}

// ── ICONS & UTILS สำหรับ WEBHOOK ──
const ICONS = {
  "Abyssal Outfit":"https://i.postimg.cc/tsDhtdxp/Abyssal-Outfit.png",
  "Abyss Edge":"https://i.postimg.cc/8fVJVs67/Abyss-Edge.png",
  "Abyss Sigil":"https://i.postimg.cc/m1GzGhHr/Abyss-Sigil.png",
  "Abyssal Empress":"https://i.postimg.cc/2bWbJnVN/Abyssal-Empress.png",
  "Adamantite":"https://i.postimg.cc/7GzGcSfT/Adamantite.png",
  "Aero Core":"https://i.postimg.cc/7JyGyb2g/Aero-Core.png",
  "Alter Armor":"https://i.postimg.cc/gLPXPrZs/Alter-Armor.png",
  "Alter Essence":"https://i.postimg.cc/p5thtyFG/Alter-Essence.png",
  "Anos Outfit":"https://i.postimg.cc/H84JWHw9/Anos-Outfit.png",
  "Atomic Core":"https://i.postimg.cc/q6XtB0sW/Atomic-Core.png",
  "Avenger Belt":"https://i.postimg.cc/p5Y9Vxf4/Avenger-Belt.png",
  "Blessed Maiden":"https://i.postimg.cc/jnQWqK6R/Blessed-Maiden.png",
  "Blood Ring":"https://i.postimg.cc/0Kd65xG5/Blood-Ring.png",
  "Blood Rune":"https://i.postimg.cc/vDWxt7J7/Blood-Rune.png",
  "Boss Key":"https://i.postimg.cc/fkxSf7Gc/Boss-Key.png",
  "Boss Ticket":"https://i.postimg.cc/JtbH53fP/Boss-Ticket.png",
  "Broken Sword":"https://i.postimg.cc/Z0rvxPGf/Broken-Sword.png",
  "Calamity Seal":"https://i.postimg.cc/HjQ890qf/Calamity-Seal.png",
  "Celestial Mark":"https://i.postimg.cc/tYpZSZbB/Celestial-Mark.png",
  "Chrysalis Sigil":"https://i.postimg.cc/HVdcZcmF/Chrysalis-Sigil.png",
  "Clan Reroll":"https://i.postimg.cc/HVdcZcHd/Clan-Reroll.png",
  "Combat":"https://i.postimg.cc/ykjJw1YV/Combat.png",
  "Common Chest":"https://i.postimg.cc/QHmBR8xs/Common-Chest.png",
  "Conqueror Fragment":"https://i.postimg.cc/dL67zstV/Conqueror-Fragment.png",
  "Corrupt Crown":"https://i.postimg.cc/Cz7ZWhLf/Corrupt-Crown.png",
  "Corruption Core":"https://i.postimg.cc/D86Wtvy6/Corruption-Core.png",
  "Crimson Heart":"https://i.postimg.cc/0zN6vTbG/Crimson-Heart.png",
  "Crimson Helmet":"https://i.postimg.cc/mPrc4vtN/Crimson-Helmet.png",
  "Cursed Finger":"https://i.postimg.cc/tsg1bKY2/Cursed-Finger.png",
  "Cursed Talisman":"https://i.postimg.cc/HrLJmqrg/Cursed-Talisman.png",
  "Dark Blade":"https://i.postimg.cc/FYKfvMYQ/Dark-Blade.png",
  "Dark Grail":"https://i.postimg.cc/NKPKjdH3/Dark-Grail.png",
  "Dark Ring":"https://i.postimg.cc/Mnrnp9BQ/Dark-Ring.png",
  "Demonic Fragment":"https://i.postimg.cc/nsjCjqKr/Demonic-Fragment.png",
  "Demonic Shard":"https://i.postimg.cc/rd0K05G0/Demonic-Shard.png",
  "Destruction Rune":"https://i.postimg.cc/p9hphKQY/Destruction-Rune.png",
  "Diamond":"https://i.postimg.cc/Ny959R8P/Diamond.png",
  "Dismantle Fang":"https://i.postimg.cc/R3kqcqGL/Dismantle-Fang.png",
  "Divergent Pulse":"https://i.postimg.cc/zLs3n3pp/Divergent-Pulse.png",
  "Dungeon Key":"https://i.postimg.cc/FfM1j1GC/Dungeon-Key.png",
  "Dungeon Token":"https://i.postimg.cc/3ysWgWn5/Dungeon-Token.png",
  "Energy Core":"https://i.postimg.cc/PLgNmN2X/Energy-Core.png",
  "Energy Shard":"https://i.postimg.cc/bD1rL8BX/Energy-Shard.png",
  "Epic Chest":"https://i.postimg.cc/1nDXMPjP/Epic-Chest.png",
  "Escanor":"https://i.postimg.cc/sQ5xKyNG/Escanor.png",
  "Flash Impact":"https://i.postimg.cc/phKrkx6f/Flash-Impact.png",
  "Fortune Rune":"https://i.postimg.cc/4HZdSMDt/Fortune-Rune.png",
  "Frost Rune":"https://i.postimg.cc/n9ZzP5yY/Frost-Rune.png",
  "Frozen Will":"https://i.postimg.cc/307Rc6sc/Frozen-Will.png",
  "Gale Essence":"https://i.postimg.cc/hQgj5wkk/Gale-Essence.png",
  "Gojo Blindfold":"https://i.postimg.cc/y3Pd4jKL/Gojo-Blindfold.png",
  "Gryphon":"https://i.postimg.cc/fSKLnCsH/Gryphon.png",
  "Guardian Rune":"https://i.postimg.cc/sGcXdmy3/Guardian-Rune.png",
  "Havoc Rune":"https://i.postimg.cc/F1QVvKmV/Havoc-Rune.png",
  "Hogyoku Fragment":"https://i.postimg.cc/7byn4LDj/Hogyoku-Fragment.png",
  "Hõgyoku Fragment":"https://i.postimg.cc/bYZCQG5Y/Hogyoku-Fragment.png",
  "Haki Color Reroll":"https://i.postimg.cc/fTSX52Jk/Haki-Color-Reroll.png",
  "Hollow Mask":"https://i.postimg.cc/0rq0vNPR/Hollow-Mask.png",
  "Ichigo":"https://i.postimg.cc/NL77jwfP/Ichigo.png",
  "Illusion Prism":"https://i.postimg.cc/grqq2P2W/Illusion-Prism.png",
  "Imperial Seal":"https://i.postimg.cc/MXbbp8pM/Imperial-Seal.png",
  "Inferno Rune":"https://i.postimg.cc/ZCbP9DWR/Inferno-Rune.png",
  "Infinity Core":"https://i.postimg.cc/5645HkXF/Infinity-Core.png",
  "Iron":"https://i.postimg.cc/qzJctZN6/Iron.png",
  "Jade Tablet":"https://i.postimg.cc/HVY0JPrw/Jade-Tablet.png",
  "Jinwoo Cape":"https://i.postimg.cc/crx7K5vF/Jinwoo-Cape.png",
  "Katana":"https://i.postimg.cc/5645HkXn/Katana.png",
  "Legendary Chest":"https://i.postimg.cc/nC34qYmT/Legendary-Chest.png",
  "Limitless Key":"https://i.postimg.cc/crFRfM3D/Limitless-Key.png",
  "Maiden Outfit":"https://i.postimg.cc/BXmT2cDf/Maiden-Outfit.png",
  "Malevolent Key":"https://i.postimg.cc/GHXFvJDV/Malevolent-Key.png",
  "Mirage Pendant":"https://i.postimg.cc/6yMrCLRw/Mirage-Pendant.png",
  "Morgan Remnant":"https://i.postimg.cc/xc6vLyH9/Morgan-Remnant.png",
  "Mythical Chest":"https://i.postimg.cc/3kWg14js/Mythical-Chest.png",
  "Mythril":"https://i.postimg.cc/w13h2ycK/Mythril.png",
  "Obsidian":"https://i.postimg.cc/WdtM8F6v/Obsidian.png",
  "Passive Shard":"https://i.postimg.cc/2134GbFY/Passive-Shard.png",
  "Qin Shi":"https://i.postimg.cc/K14nfkrZ/Qin-Shi.png",
  "Qin Shi Blindfold":"https://i.postimg.cc/zy3n7bS8/Qin-Shi-Blindfold.png",
  "Race Reroll":"https://i.postimg.cc/WdtM8F6N/Race-Reroll.png",
  "Rare Chest":"https://i.postimg.cc/3kWg14Cx/Rare-Chest.png",
  "Reiatsu Core":"https://i.postimg.cc/gxrvsXqj/Reiatsu-Core.png",
  "Rush Coin":"https://i.postimg.cc/ts7hkZtY/Rush-Coin.png",
  "Rush Key":"https://i.postimg.cc/HrjQzc4j/Rush-Key.png",
  "Saber":"https://i.postimg.cc/BjtxpLcK/Saber.png",
  "Saber Alter":"https://i.postimg.cc/ts7hkZt1/Saber-Alter.png",
  "Saber Armor":"https://i.postimg.cc/BjtxpLc1/Saber-Armor.png",
  "Sage Pulse":"https://i.postimg.cc/pmyDChYj/Sage-Pulse.png",
  "Shadow Cloak":"https://i.postimg.cc/RWqcd6Qw/Shadow-Cloak.png",
  "Shadow Essence":"https://i.postimg.cc/bZM1By3d/Shadow-Essence.png",
  "Shadow Heart":"https://i.postimg.cc/bZM1By3t/Shadow-Heart.png",
  "Silent Storm":"https://i.postimg.cc/jD9yFxZH/Silent-Storm.png",
  "Slime Key":"https://i.postimg.cc/Bjy2VSM5/Slime-Key.png",
  "Slime Mask":"https://i.postimg.cc/FYq0BrDg/Slime-Mask.png",
  "Slime Shard":"https://i.postimg.cc/mPq75L88/Slime-Shard.png",
  "Soul Amulet":"https://i.postimg.cc/QFPcy80y/Soul-Amulet.png",
  "Soul Flame":"https://i.postimg.cc/v1V5RJNh/Soul-Flame.png",
  "Soul Fragment":"https://i.postimg.cc/SXMc0BvV/Soul-Fragment.png",
  "Spiritual Core":"https://i.postimg.cc/XZC9MRzm/Spiritual-Core.png",
  "Sukuna Collar":"https://i.postimg.cc/cKnfqpzq/Sukuna-Collar.png",
  "Sun Armor":"https://i.postimg.cc/hJdVFkYt/Sun-Armor.png",
  "Suppression Rune":"https://i.postimg.cc/G8nGbM0R/Suppression-Rune.png",
  "Tempest Relic":"https://i.postimg.cc/KkhBm9X8/Tempest-Relic.png",
  "Tempest Seal":"https://i.postimg.cc/dkcrJWM7/Tempest-Seal.png",
  "Thunder Cape":"https://i.postimg.cc/FdX3hPtc/Thunder-Cape.png",
  "Tide Remnant":"https://i.postimg.cc/FdbczjmL/Tide-Remnant.png",
  "Tower Key":"https://i.postimg.cc/r02xqh6J/Tower-Key.png",
  "Tower Token":"https://i.postimg.cc/DJQs0qFQ/Tower-Token.png",
  "Trait Reroll":"https://i.postimg.cc/0MGmjpxc/Trait-Reroll.png",
  "Umbral Capsule":"https://i.postimg.cc/PpbZJmhV/Umbral-Capsule.png",
  "Void Fragment":"https://i.postimg.cc/BL5Dbxsd/Void-Fragment.png",
  "Void Seed":"https://i.postimg.cc/D42GX8yY/Void-Seed.png",
  "Wood":"https://i.postimg.cc/GTcDyHmn/Wood.png",
  "Worthiness Fragment":"https://i.postimg.cc/rR84rKwk/Worthiness-Fragment.png",
  "Wrath Rune":"https://i.postimg.cc/7Jxz2fZx/Wrath-Rune.png",
  "Yuji Hair":"https://i.postimg.cc/q6kK3zvJ/Yuji-Hair.png",
};

function normalizeStr(s) {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
}
function resolveIcon(name) {
  if (ICONS[name]) return ICONS[name];
  let s = name.replace(/\s*\(.*?\)/g,'').trim();
  if (ICONS[s]) return ICONS[s];
  s = s.replace(/\s*\[.*?\]/g,'').trim();
  if (ICONS[s]) return ICONS[s];
  s = s.replace(/\s+\w*\d+\w*$/,'').trim();
  if (ICONS[s]) return ICONS[s];
  const normInput = normalizeStr(s);
  for (const key of Object.keys(ICONS)) {
    const k = normalizeStr(key);
    if (normInput===k || normInput.startsWith(k+' ') || k.startsWith(normInput+' ')) return ICONS[key];
  }
  return null;
}

function rarity(name) {
  const n = name.toLowerCase();
  // เพิ่ม Limitless และ Malevolent เข้าไปในระดับ leg เพื่อให้แจ้งเตือน Webhook
  if(['mythical','legendary','empress','escanor','ichigo','gryphon','jinwoo','saber alter','limitless','malevolent'].some(k=>n.includes(k))) return 'leg';
  if(['epic','corrupt','imperial','calamity','shadow','abyssal','infinity','atomic'].some(k=>n.includes(k))) return 'epic';
  if(['rare','soul','crimson','dark','frozen','celestial','demonic'].some(k=>n.includes(k))) return 'rare';
  return '';
}

function parseRaw(json) {
  const out = {};
  for (const [cat, val] of Object.entries(json)) {
    if (Array.isArray(val)) out[cat] = val;
    else if (typeof val === 'object')
      out[cat] = Object.entries(val).map(([name,qty])=>({
        Name:name, Quantity:typeof qty==='number'?qty:1, Extra:''
      }));
  }
  return out;
}

function flattenInventory(d) {
  const out = {};
  for (const items of Object.values(d)) {
    (items || []).forEach(item => {
      out[item.Name] = (out[item.Name] || 0) + item.Quantity;
    });
  }
  return out;
}

function calcDiff(before, after) {
  const diff = {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  keys.forEach(k => {
    const d = (after[k] || 0) - (before[k] || 0);
    if (d !== 0) diff[k] = d;
  });
  return diff;
}

function sendDiscordWebhook(rareDrops) {
  if (!DISCORD_WEBHOOK_URL || DISCORD_WEBHOOK_URL.trim() === '') return;

  const embeds = rareDrops.map(d => {
    const icon = resolveIcon(d.name);
    return {
      title: "🎉 RARE ITEM DROP!",
      description: `**${d.name}** ได้รับจำนวน x${d.qty}`,
      color: 16711680, // สีแดง
      thumbnail: icon ? { url: icon } : undefined
    };
  });

  const payload = JSON.stringify({
    username: "Sailor Piece Tracker",
    embeds: embeds
  });

  try {
    const { URL } = require('url');
    const hookUrl = new URL(DISCORD_WEBHOOK_URL);
    const req = https.request({
      hostname: hookUrl.hostname,
      path: hookUrl.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    });
    req.on('error', e => console.error('[❌ WEBHOOK] Error:', e.message));
    req.write(payload);
    req.end();
    console.log(`[📼 WEBHOOK] ส่งแจ้งเตือนของแรร์ไปยัง Discord ${rareDrops.length} ชิ้น`);
  } catch(e) {
    console.error('[❌ WEBHOOK] Invalid URL:', e.message);
  }
}

function checkRareDrops(oldNormalized, newNormalized) {
  if (!oldNormalized || !newNormalized) return;
  const oldF = flattenInventory(oldNormalized);
  const newF = flattenInventory(newNormalized);
  const diff = calcDiff(oldF, newF);

  const rareDrops = [];
  for (const [name, qty] of Object.entries(diff)) {
    if (qty > 0) {
      const r = rarity(name);
      if (r === 'leg') {
        rareDrops.push({ name, qty });
      }
    }
  }
  if (rareDrops.length > 0) {
    sendDiscordWebhook(rareDrops);
  }
}

// ── SERVER UTILS ──
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

// ── server ───────────────────────────────────────────────────
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
      const newNormalized = parseRaw(json);
      
      // ตรวจสอบของแรร์และส่ง Webhook
      checkRareDrops(latestNormalized, newNormalized);

      lastInvHash      = hash;
      latestInventory  = json;
      latestNormalized = newNormalized;
      lastReceived     = new Date().toISOString();
      
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
      if ('thisRun' in json) dungeonRuns.thisRun = json.thisRun;
      if ('lastRun' in json) dungeonRuns.lastRun = json.lastRun;
      console.log(`[DUNGEON] 💾 บันทึก runs (thisRun:${!!dungeonRuns.thisRun} lastRun:${!!dungeonRuns.lastRun})`);
      saveDungeonRunsToDB(); // บันทึกลง SQLite
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
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

    if (latestInventory) {
      res.write(`data: ${JSON.stringify({ type:'inventory', inventory: latestInventory, lastReceived })}\n\n`);
    }
    if (latestStats) {
      res.write(`data: ${JSON.stringify({ type:'stats', stats: latestStats, lastReceived: lastStatsReceived })}\n\n`);
    }
    if (dungeonRuns.thisRun || dungeonRuns.lastRun) {
      res.write(`data: ${JSON.stringify({ type:'dungeonRuns', thisRun: dungeonRuns.thisRun, lastRun: dungeonRuns.lastRun })}\n\n`);
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
  console.log('║   INVENTORY SERVER — SSE + Webhook Edition!  ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║  Local  : http://localhost:${PORT}             ║`);
  console.log('╠══════════════════════════════════════════╣');
  console.log('║  POST /        ← Inventory จาก Lua          ║');
  console.log('║  POST /stats   ← Stats+Wave จาก Lua         ║');
  console.log('║  GET  /events  ← SSE push ไปเว็บ           ║');
  console.log('║  GET  /        ← หน้าเว็บ                   ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log('║  💡 SQLite: หากต้องการบันทึกถาวร ให้พิมพ์:     ║');
  console.log('║              npm install sqlite3            ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
});
