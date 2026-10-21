// 產品找店家：共用「狀態」伺服器（Cloudflare Worker＋D1）
//
// 使用者（用「編號＋姓名」登入，使用者由管理員在後台新增）
//   POST /login           {id, name}        → {token, me}
//   GET  /status          （要登入）        → {me: {id, name, role}, items: [{key, p, s, by, uid, t, name, addr, ind, ci, d, phone}]}
//   POST /status          （要登入）        → 設定一家店在某個產品（p）下的狀態，s 空字串＝取消；標記人＝登入的使用者
// 權限（role）：lead 主管＝可改所有人的標記／user 一般＝只能改自己標的／view 檢視＝只能看／off 停用＝不能登入
// 管理員（後台，用 ADMIN_PASSWORD 登入）
//   POST /admin/login     {password}        → {token}
//   GET  /admin/status                      → 全部狀態
//   POST /admin/status    {key, p, s}       → 改狀態或取消（s 空字串）
//   GET  /admin/users                       → 使用者名單
//   POST /admin/users     {oldId?, id, name, role} → 新增（沒有 oldId）或修改（可改編號、姓名、權限）
//   POST /admin/users/delete {id}           → 刪除使用者
//   GET  /admin/log?before=<id>             → 修改紀錄（新到舊，每次 200 筆）
//
// 機密設定（wrangler secret put）：ADMIN_PASSWORD、SESSION_SECRET

const STATUSES = ['call', 'visit', 'no', 'deal'];
const ROLES = ['lead', 'user', 'view', 'off'];
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
  if (p === '/status' && m === 'GET') { const me = await needUser(req, env); return { me, items: await listStatus(env) }; }
  if (p === '/status' && m === 'POST') { const me = await needUser(req, env); return saveStatus(req, env, me); }
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

/* 憑證裡只放使用者的內部序號（rowid），後台改了編號或姓名也不用重新登入；
   每次都重新讀權限，停用或降權立刻生效 */
async function needUser(req, env) {
  const t = await readToken(req, env);
  if (!t || t.role !== 'user' || !t.rid) fail('請先登入', 401);
  const u = await env.DB.prepare('SELECT id, name, role FROM users WHERE rowid = ?').bind(t.rid).first();
  if (!u) fail('找不到這個使用者，請重新登入', 401);
  if (u.role === 'off') fail('這個帳號已被停用，請聯絡管理員', 401);
  return u;
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
  const b = await body(req);
  const id = str(b.id, 20), name = str(b.name, 20);
  if (!id || !name) fail('請輸入編號和姓名');
  const u = await env.DB.prepare('SELECT rowid AS rid, id, name, role FROM users WHERE id = ? COLLATE NOCASE').bind(id).first();
  if (!u || u.name !== name) {
    await noteLogin(env, ip, false, id + ' ' + name);
    fail('編號或姓名不正確，請確認或聯絡管理員', 403);
  }
  if (u.role === 'off') { await noteLogin(env, ip, false, id + ' ' + name); fail('這個帳號已被停用，請聯絡管理員', 403); }
  await noteLogin(env, ip, true, u.id + ' ' + u.name);
  await env.DB.prepare('UPDATE users SET last = ? WHERE rowid = ?').bind(Date.now(), u.rid).run();
  return { token: await makeToken(env, { role: 'user', rid: u.rid }, USER_DAYS), me: { id: u.id, name: u.name, role: u.role } };
}

async function listStatus(env) {
  const { results } = await env.DB.prepare('SELECT key, p, s, by, uid, t, name, addr, ind, ci, d, phone FROM status').all();
  return results;
}

function checkKey(key) {
  if (!/^[csnwr]\d{1,20}$/.test(key)) fail('店家代號錯誤');
}

async function saveStatus(req, env, me) {
  if (me.role === 'view') fail('你的權限只能查看，不能標記', 403);
  const b = await body(req);
  const key = str(b.key, 40), p = str(b.p, 20), s = str(b.s, 10);
  checkKey(key);
  if (s && !STATUSES.includes(s)) fail('狀態錯誤');
  if (s && !p) fail('缺少產品');
  // 一般權限只能改自己標的（沒有標記人的舊紀錄大家都能改）
  const cur = await env.DB.prepare('SELECT uid, by FROM status WHERE key = ? AND p = ?').bind(key, p).first();
  if (cur && cur.uid && cur.uid !== me.id && me.role !== 'lead') fail(`這筆是 ${cur.by} 標記的，只有本人或主管可以修改`, 403);
  const ip = ipOf(req), now = Date.now();
  const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM log WHERE ip = ? AND t > ?').bind(ip, now - 3600e3).first();
  if (n >= MAX_WRITES_PER_HOUR) fail('修改太頻繁，請稍後再試', 429);
  const name = str(b.name, 100);
  const stmts = [];
  if (s) {
    stmts.push(env.DB.prepare(`INSERT INTO status (key, p, s, by, uid, t, name, addr, ind, ci, d, phone) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(key, p) DO UPDATE SET s=excluded.s, by=excluded.by, uid=excluded.uid, t=excluded.t, name=excluded.name, addr=excluded.addr,
      ind=excluded.ind, ci=excluded.ci, d=excluded.d, phone=excluded.phone`)
      .bind(key, p, s, me.name, me.id, now, name, str(b.addr, 200), str(b.ind, 30), Number.isInteger(b.ci) ? b.ci : null, str(b.d, 10), str(b.phone, 30)));
  } else {
    stmts.push(env.DB.prepare('DELETE FROM status WHERE key = ? AND p = ?').bind(key, p));
  }
  stmts.push(env.DB.prepare('INSERT INTO log (key, p, s, by, uid, t, name, ip) VALUES (?,?,?,?,?,?,?,?)').bind(key, p, s, me.name, me.id, now, name, ip));
  await env.DB.batch(stmts);
  return { ok: true, t: now, by: me.name, uid: me.id };
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
    s ? env.DB.prepare('UPDATE status SET s = ?, by = ?, uid = NULL, t = ? WHERE key = ? AND p = ?').bind(s, ADMIN_BY, now, key, p)
      : env.DB.prepare('DELETE FROM status WHERE key = ? AND p = ?').bind(key, p),
    env.DB.prepare('INSERT INTO log (key, p, s, by, t, name, ip) VALUES (?,?,?,?,?,?,?)').bind(key, p, s, ADMIN_BY, now, row.name, ipOf(req)),
  ]);
  return { ok: true, t: now };
}

async function listUsers(env) {
  const { results } = await env.DB.prepare(`SELECT u.id, u.name, u.role, u.created, u.last,
    (SELECT COUNT(*) FROM status s WHERE s.uid = u.id) AS marks FROM users u ORDER BY u.role = 'off', u.id`).all();
  return results;
}

/* 新增或修改使用者；改了編號或姓名，他標過的狀態也一起改 */
async function saveUser(req, env) {
  const b = await body(req);
  const oldId = str(b.oldId, 20), id = str(b.id, 20), name = str(b.name, 20);
  const role = ROLES.includes(b.role) ? b.role : 'user';
  if (!id) fail('請輸入編號');
  if (!name) fail('請輸入姓名');
  if (name === ADMIN_BY) fail('「管理員」是保留名稱');
  const dup = await env.DB.prepare('SELECT id FROM users WHERE id = ? COLLATE NOCASE').bind(id).first();
  if (!oldId) {
    if (dup) fail(`編號 ${dup.id} 已經有人使用`);
    await env.DB.prepare('INSERT INTO users (id, name, role, created) VALUES (?,?,?,?)').bind(id, name, role, Date.now()).run();
    return { ok: true };
  }
  const cur = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(oldId).first();
  if (!cur) fail('找不到這個使用者', 404);
  if (dup && dup.id !== oldId) fail(`編號 ${dup.id} 已經有人使用`);
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET id = ?, name = ?, role = ? WHERE id = ?').bind(id, name, role, oldId),
    env.DB.prepare('UPDATE status SET uid = ?, by = ? WHERE uid = ?').bind(id, name, oldId),
  ]);
  return { ok: true };
}

async function deleteUser(req, env) {
  const id = str((await body(req)).id, 20);
  await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
  return { ok: true };
}

async function listLog(env, url) {
  const before = parseInt(url.searchParams.get('before') || '0', 10);
  const q = before > 0
    ? env.DB.prepare('SELECT id, key, p, s, by, uid, t, name FROM log WHERE id < ? ORDER BY id DESC LIMIT 200').bind(before)
    : env.DB.prepare('SELECT id, key, p, s, by, uid, t, name FROM log ORDER BY id DESC LIMIT 200');
  return (await q.all()).results;
}
