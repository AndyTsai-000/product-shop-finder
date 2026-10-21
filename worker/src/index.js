// 產品找店家：共用「狀態」伺服器（Cloudflare Worker＋D1）
//
// 使用者（只輸入名字登入，名字要先由管理員在後台加入）
//   POST /login           {name}            → {token, name}
//   GET  /status          （要登入）        → 全部狀態 [{key, p, s, by, t, name, addr, ind, ci, d, phone}]
//   POST /status          （要登入）        → 設定一家店在某個產品（p）下的狀態，s 空字串＝取消；標記人＝登入的名字
// 管理員（後台，用 ADMIN_PASSWORD 登入）
//   POST /admin/login     {password}        → {token}
//   GET  /admin/status                      → 全部狀態
//   POST /admin/status    {key, p, s}       → 改狀態或取消（s 空字串）
//   GET  /admin/users                       → 使用者名單
//   POST /admin/users     {name, active}    → 新增或啟用／停用
//   POST /admin/users/delete {name}         → 刪除使用者
//   GET  /admin/log?before=<id>             → 修改紀錄（新到舊，每次 200 筆）
//
// 機密設定（wrangler secret put）：ADMIN_PASSWORD、SESSION_SECRET

const STATUSES = ['call', 'visit', 'no', 'deal'];
const MAX_WRITES_PER_HOUR = 600;
const MAX_FAILED_LOGINS_PER_HOUR = 10;
const USER_DAYS = 90, ADMIN_DAYS = 7;
const ADMIN_BY = '管理員';

export default {
  async fetch(req, rawEnv) {
    const env = Object.fromEntries(Object.entries(rawEnv).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]));
    const cors = corsHeaders(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      if (!cors['Access-Control-Allow-Origin'] && req.method !== 'GET') fail('來源不允許', 403);
      return json(await route(req, env, new URL(req.url)), 200, cors);
    } catch (e) {
      return json({ error: e.message || String(e) }, e.status || 500, cors);
    }
  },
};

async function route(req, env, url) {
  const p = url.pathname, m = req.method;
  if (p === '/login' && m === 'POST') return userLogin(req, env);
  if (p === '/status' && m === 'GET') { await needUser(req, env); return listStatus(env); }
  if (p === '/status' && m === 'POST') { const name = await needUser(req, env); return saveStatus(req, env, name); }
  if (p === '/admin/login' && m === 'POST') return adminLogin(req, env);
  if (p.startsWith('/admin/')) {
    await needAdmin(req, env);
    if (p === '/admin/status' && m === 'GET') return listStatus(env);
    if (p === '/admin/status' && m === 'POST') return adminSetStatus(req, env);
    if (p === '/admin/users' && m === 'GET') return listUsers(env);
    if (p === '/admin/users' && m === 'POST') return saveUser(req, env);
    if (p === '/admin/users/delete' && m === 'POST') return deleteUser(req, env);
    if (p === '/admin/log' && m === 'GET') return listLog(env, url);
  }
  fail('not found', 404);
}

/* ---------- 共用 ---------- */

function corsHeaders(req, env) {
  const origin = req.headers.get('Origin') || '';
  const allowed = (env.APP_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const h = { 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Vary': 'Origin' };
  if (allowed.includes(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}

function fail(msg, status = 400) { const e = new Error(msg); e.status = status; throw e; }
const str = (v, n) => String(v ?? '').trim().slice(0, n);
const body = req => req.json().catch(() => fail('格式錯誤'));
const ipOf = req => req.headers.get('CF-Connecting-IP') || '';

/* ---------- 登入憑證：base64url(JSON).HMAC ---------- */

const enc = new TextEncoder();
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

async function hmac(env, text) {
  if (!env.SESSION_SECRET) fail('伺服器尚未設定 SESSION_SECRET', 500);
  const key = await crypto.subtle.importKey('raw', enc.encode(env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(await crypto.subtle.sign('HMAC', key, enc.encode(text)));
}

async function makeToken(env, data, days) {
  const payload = b64u(enc.encode(JSON.stringify({ ...data, exp: Date.now() + days * 864e5 })));
  return payload + '.' + await hmac(env, payload);
}

async function readToken(req, env) {
  const t = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const [payload, sig] = t.split('.');
  if (!payload || !sig || sig !== await hmac(env, payload)) return null;
  try {
    const data = JSON.parse(new TextDecoder().decode(fromB64u(payload)));
    return data.exp > Date.now() ? data : null;
  } catch { return null; }
}

async function needUser(req, env) {
  const t = await readToken(req, env);
  if (!t || t.role !== 'user') fail('請先登入', 401);
  const u = await env.DB.prepare('SELECT active FROM users WHERE name = ?').bind(t.name).first();
  if (!u || !u.active) fail('這個名字已被停用，請聯絡管理員', 401);
  return t.name;
}

async function needAdmin(req, env) {
  const t = await readToken(req, env);
  if (!t || t.role !== 'admin') fail('請先登入後台', 401);
}

async function guardLogin(env, ip) {
  const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM logins WHERE ip = ? AND ok = 0 AND t > ?').bind(ip, Date.now() - 3600e3).first();
  if (n >= MAX_FAILED_LOGINS_PER_HOUR) fail('登入失敗太多次，請一小時後再試', 429);
}
const noteLogin = (env, ip, ok, who) => env.DB.prepare('INSERT INTO logins (ip, t, ok, who) VALUES (?,?,?,?)').bind(ip, Date.now(), ok ? 1 : 0, who).run();

/* ---------- 使用者 ---------- */

async function userLogin(req, env) {
  const ip = ipOf(req);
  await guardLogin(env, ip);
  const name = str((await body(req)).name, 20);
  if (!name) fail('請輸入名字');
  const u = await env.DB.prepare('SELECT name, active FROM users WHERE name = ?').bind(name).first();
  if (!u || !u.active) {
    await noteLogin(env, ip, false, name);
    fail(u ? '這個名字已被停用，請聯絡管理員' : '名單裡沒有這個名字，請聯絡管理員加入', 403);
  }
  await noteLogin(env, ip, true, name);
  await env.DB.prepare('UPDATE users SET last = ? WHERE name = ?').bind(Date.now(), name).run();
  return { token: await makeToken(env, { role: 'user', name }, USER_DAYS), name };
}

async function listStatus(env) {
  const { results } = await env.DB.prepare('SELECT key, p, s, by, t, name, addr, ind, ci, d, phone FROM status').all();
  return results;
}

function checkKey(key) {
  if (!/^[csnwr]\d{1,20}$/.test(key)) fail('店家代號錯誤');
}

async function saveStatus(req, env, by) {
  const b = await body(req);
  const key = str(b.key, 40), p = str(b.p, 20), s = str(b.s, 10);
  checkKey(key);
  if (s && !STATUSES.includes(s)) fail('狀態錯誤');
  if (s && !p) fail('缺少產品');
  const ip = ipOf(req), now = Date.now();
  const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM log WHERE ip = ? AND t > ?').bind(ip, now - 3600e3).first();
  if (n >= MAX_WRITES_PER_HOUR) fail('修改太頻繁，請稍後再試', 429);
  const name = str(b.name, 100);
  const stmts = [];
  if (s) {
    stmts.push(env.DB.prepare(`INSERT INTO status (key, p, s, by, t, name, addr, ind, ci, d, phone) VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(key, p) DO UPDATE SET s=excluded.s, by=excluded.by, t=excluded.t, name=excluded.name, addr=excluded.addr,
      ind=excluded.ind, ci=excluded.ci, d=excluded.d, phone=excluded.phone`)
      .bind(key, p, s, by, now, name, str(b.addr, 200), str(b.ind, 30), Number.isInteger(b.ci) ? b.ci : null, str(b.d, 10), str(b.phone, 30)));
  } else {
    stmts.push(env.DB.prepare('DELETE FROM status WHERE key = ? AND p = ?').bind(key, p));
  }
  stmts.push(env.DB.prepare('INSERT INTO log (key, p, s, by, t, name, ip) VALUES (?,?,?,?,?,?,?)').bind(key, p, s, by, now, name, ip));
  await env.DB.batch(stmts);
  return { ok: true, t: now, by };
}

/* ---------- 管理員 ---------- */

async function adminLogin(req, env) {
  const ip = ipOf(req);
  await guardLogin(env, ip);
  if (!env.ADMIN_PASSWORD) fail('伺服器尚未設定 ADMIN_PASSWORD', 500);
  const pw = str((await body(req)).password, 100);
  // 比對雜湊，避免逐字比較洩漏時間差
  const ok = pw && await hmac(env, 'pw:' + pw) === await hmac(env, 'pw:' + env.ADMIN_PASSWORD);
  await noteLogin(env, ip, ok, '(後台)');
  if (!ok) fail('密碼錯誤', 403);
  return { token: await makeToken(env, { role: 'admin' }, ADMIN_DAYS) };
}

async function adminSetStatus(req, env) {
  const b = await body(req);
  const key = str(b.key, 40), p = str(b.p, 20), s = str(b.s, 10);
  checkKey(key);
  if (s && !STATUSES.includes(s)) fail('狀態錯誤');
  const row = await env.DB.prepare('SELECT name FROM status WHERE key = ? AND p = ?').bind(key, p).first();
  if (!row) fail('找不到這筆狀態（可能已被取消）', 404);
  const now = Date.now();
  await env.DB.batch([
    s ? env.DB.prepare('UPDATE status SET s = ?, by = ?, t = ? WHERE key = ? AND p = ?').bind(s, ADMIN_BY, now, key, p)
      : env.DB.prepare('DELETE FROM status WHERE key = ? AND p = ?').bind(key, p),
    env.DB.prepare('INSERT INTO log (key, p, s, by, t, name, ip) VALUES (?,?,?,?,?,?,?)').bind(key, p, s, ADMIN_BY, now, row.name, ipOf(req)),
  ]);
  return { ok: true, t: now };
}

async function listUsers(env) {
  const { results } = await env.DB.prepare(`SELECT u.name, u.active, u.created, u.last,
    (SELECT COUNT(*) FROM status s WHERE s.by = u.name) AS marks FROM users u ORDER BY u.active DESC, u.name`).all();
  return results;
}

async function saveUser(req, env) {
  const b = await body(req);
  const name = str(b.name, 20);
  if (!name) fail('請輸入名字');
  if (name === ADMIN_BY) fail('「管理員」是保留名稱');
  const active = b.active === false ? 0 : 1;
  await env.DB.prepare('INSERT INTO users (name, active, created) VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET active = excluded.active')
    .bind(name, active, Date.now()).run();
  return { ok: true };
}

async function deleteUser(req, env) {
  const name = str((await body(req)).name, 20);
  await env.DB.prepare('DELETE FROM users WHERE name = ?').bind(name).run();
  return { ok: true };
}

async function listLog(env, url) {
  const before = parseInt(url.searchParams.get('before') || '0', 10);
  const q = before > 0
    ? env.DB.prepare('SELECT id, key, p, s, by, t, name FROM log WHERE id < ? ORDER BY id DESC LIMIT 200').bind(before)
    : env.DB.prepare('SELECT id, key, p, s, by, t, name FROM log ORDER BY id DESC LIMIT 200');
  return (await q.all()).results;
}
