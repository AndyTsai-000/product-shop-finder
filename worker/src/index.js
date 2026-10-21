// 產品找店家：共用「狀態」伺服器（Cloudflare Worker＋D1）
// GET  /status        → 全部店家的狀態 { key: {s, by, t, name, addr, ind, ci, d, phone} }
// POST /status        → 設定一家店的狀態，s 空字串＝清除
// 不用登入；只接受網站來源的瀏覽器請求，並限制每個 IP 的寫入次數。

const STATUSES = ['call', 'visit', 'no', 'deal'];
const MAX_WRITES_PER_HOUR = 600;

export default {
  async fetch(req, env) {
    const cors = corsHeaders(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      const url = new URL(req.url);
      if (url.pathname === '/status' && req.method === 'GET') return json(await list(env), 200, cors);
      if (url.pathname === '/status' && req.method === 'POST') {
        if (!cors['Access-Control-Allow-Origin']) return json({ error: '來源不允許' }, 403, cors);
        return json(await save(req, env), 200, cors);
      }
      return json({ error: 'not found' }, 404, cors);
    } catch (e) {
      return json({ error: e.message || String(e) }, e.status || 500, cors);
    }
  },
};

function corsHeaders(req, env) {
  const origin = req.headers.get('Origin') || '';
  const allowed = (env.APP_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const h = { 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Vary': 'Origin' };
  if (allowed.includes(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}

function fail(msg, status = 400) { const e = new Error(msg); e.status = status; throw e; }
const str = (v, n) => String(v ?? '').trim().slice(0, n);

async function list(env) {
  const { results } = await env.DB.prepare('SELECT key, s, by, t, name, addr, ind, ci, d, phone FROM status').all();
  const out = {};
  for (const r of results) { const { key, ...rest } = r; out[key] = rest; }
  return out;
}

async function save(req, env) {
  const b = await req.json().catch(() => fail('格式錯誤'));
  const key = str(b.key, 40);
  if (!/^[csnwr]\d{1,20}$/.test(key)) fail('店家代號錯誤');
  const s = str(b.s, 10);
  if (s && !STATUSES.includes(s)) fail('狀態錯誤');
  const ip = req.headers.get('CF-Connecting-IP') || '';
  const now = Date.now();
  const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM log WHERE ip = ? AND t > ?').bind(ip, now - 3600e3).first();
  if (n >= MAX_WRITES_PER_HOUR) fail('修改太頻繁，請稍後再試', 429);
  const by = str(b.by, 20), name = str(b.name, 100);
  const stmts = [];
  if (s) {
    stmts.push(env.DB.prepare(`INSERT INTO status (key, s, by, t, name, addr, ind, ci, d, phone) VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(key) DO UPDATE SET s=excluded.s, by=excluded.by, t=excluded.t, name=excluded.name, addr=excluded.addr,
      ind=excluded.ind, ci=excluded.ci, d=excluded.d, phone=excluded.phone`)
      .bind(key, s, by, now, name, str(b.addr, 200), str(b.ind, 30), Number.isInteger(b.ci) ? b.ci : null, str(b.d, 10), str(b.phone, 30)));
  } else {
    stmts.push(env.DB.prepare('DELETE FROM status WHERE key = ?').bind(key));
  }
  stmts.push(env.DB.prepare('INSERT INTO log (key, s, by, t, name, ip) VALUES (?,?,?,?,?,?)').bind(key, s, by, now, name, ip));
  await env.DB.batch(stmts);
  return { ok: true, t: now };
}
