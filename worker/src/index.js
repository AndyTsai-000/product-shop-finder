// 產品找店家：共用「狀態」伺服器（Cloudflare Worker＋D1）
//
// 使用者（用「編號＋姓名」登入，使用者由管理員在後台新增）
//   POST /login           {id, name}        → {token, me}
//   GET  /status          （要登入）        → {me: {id, name, role, other?}, items: [{key, p, s, by, uid, t, name, addr, ind, ci, d, phone}]}
//   POST /status          （要登入）        → 設定一家店在某個產品（p）下的狀態，s 空字串＝取消；標記人＝登入的使用者
//   GET  /notes?key=&p=   （要登入）        → 這家店在這個產品下的跟進紀錄 [{id, uid, by, t, text}]（新到舊）
//   POST /notes           （要登入）{key, p, text} → 新增一則跟進紀錄（只有標記這家店的人可以寫）
//   POST /notes/delete    （要登入）{id}    → 刪除自己寫的跟進紀錄
//   POST /contact         （要登入）{key, p, cn, cj, cm} → 聯絡窗口（姓名、職稱、手機；只有標記的人可以改）
//   GET  /notes/mine      （要登入）        → 我標記的店家的全部跟進紀錄（匯出用）
//   GET  /recommend       （要登入）        → {day, items}：今天推薦給我的店家
//   POST /recommend       （要登入）{items} → 從前台挑好的候選（已排序）裡，去掉已有人標記、7 天內推薦給別人的，存成今天的推薦（換一批會換掉還沒標記的）
//   POST /next            （要登入）{key, p, nx} → 設定下次聯絡日期（YYYY-MM-DD，空字串＝清除；只有標記的人可以設）
//   POST /related         （要登入）{product, inds} → {partner, client}：自行輸入的產品由 AI 從 inds 挑相關產業（結果存起來，同產品不再問）
// 同一個帳號在別的瀏覽器登入後，舊瀏覽器的 me 會多 other: {t, ua}（最後一次登入的時間、裝置），前台跳提醒
// 權限（role）：user 一般＝只能改自己標的／view 檢視＝只能看／off 停用＝不能登入（別人標的只有後台能改）
// 管理員（後台，用「使用者名稱＋密碼」登入；帳號存在 admin 表，第一次用 admin＋ADMIN_PASSWORD）
//   POST /admin/login     {username, password} → {token, username}
//   GET  /admin/account                     → {username}
//   POST /admin/account   {current, username, password?} → 改使用者名稱／密碼（要目前的密碼），回新的 {token}
//   GET  /admin/status                      → 全部狀態
//   POST /admin/status    {key, p, s}       → 改狀態或取消（s 空字串）
//   GET  /admin/notes?key=&p=               → 跟進紀錄
//   POST /admin/notes/delete {id}           → 刪除一則跟進紀錄
//   GET  /admin/notes/all                   → 全部跟進紀錄（匯出用）
//   GET  /admin/report?since=<毫秒>          → 統計報表（每人的電聯／拜訪／合作數、跟進則數、各產品狀態）
//   GET  /admin/users                       → 使用者名單（含最後登入的裝置 sidua）
//   POST /admin/users     {oldId?, id, name, role} → 新增（沒有 oldId）或修改（可改編號、姓名、權限）
//   POST /admin/users/delete {id}           → 刪除使用者
//   GET  /admin/log?since=<毫秒>&before=<id> → 修改紀錄（新到舊，每次 200 筆；since 起算時間，0＝全部）
//   POST /admin/log/clear {since}            → 清除 since 之後的紀錄（0＝全部），回傳刪掉幾筆
//
// 機密設定（wrangler secret put）：ADMIN_PASSWORD（第一次登入用的初始密碼）、SESSION_SECRET

const STATUSES = ['call', 'visit', 'no', 'deal'];
const ROLES = ['user', 'view', 'off'];
const MAX_WRITES_PER_HOUR = 600;
const MAX_FAILED_LOGINS_PER_HOUR = 10;
const USER_DAYS = 90, ADMIN_DAYS = 7;
const ADMIN_BY = '管理員';
const AI_MODEL = '@cf/openai/gpt-oss-120b';
const MAX_AI_PER_HOUR = 100;
const MAX_NOTES_PER_HOUR = 300;
const NOTE_LEN = 500;
const REC_N = 15;             // 每天推薦幾家
const REC_DAYS_OTHERS = 7;    // 推薦給別人的店家，幾天內不再推薦給其他人
const twDay = (t = Date.now()) => new Date(t + 8 * 3600e3).toISOString().slice(0, 10);

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
  if (p === '/notes/mine' && m === 'GET') { const me = await needUser(req, env); return myNotes(env, me); }
  if (p === '/contact' && m === 'POST') { const me = await needUser(req, env); return setContact(req, env, me); }
  if (p === '/recommend' && m === 'GET') { const me = await needUser(req, env); return getRecs(env, me); }
  if (p === '/recommend' && m === 'POST') { const me = await needUser(req, env); return makeRecs(req, env, me); }
  if (p === '/notes' && m === 'GET') { await needUser(req, env); return listNotes(env, url); }
  if (p === '/notes' && m === 'POST') { const me = await needUser(req, env); return addNote(req, env, me); }
  if (p === '/notes/delete' && m === 'POST') { const me = await needUser(req, env); return deleteNote(req, env, me); }
  if (p === '/next' && m === 'POST') { const me = await needUser(req, env); return setNext(req, env, me); }
  if (p === '/related' && m === 'POST') { await needUser(req, env); return related(req, env); }
  if (p === '/admin/login' && m === 'POST') return adminLogin(req, env);
  if (p.startsWith('/admin/')) {
    await needAdmin(req, env);
    if (p === '/admin/account' && m === 'GET') return { username: (await getAdmin(env)).username };
    if (p === '/admin/account' && m === 'POST') return saveAccount(req, env);
    if (p === '/admin/status' && m === 'GET') return listStatus(env);
    if (p === '/admin/status' && m === 'POST') return adminSetStatus(req, env);
    if (p === '/admin/notes' && m === 'GET') return listNotes(env, url);
    if (p === '/admin/notes/all' && m === 'GET') return allNotes(env);
    if (p === '/admin/report' && m === 'GET') return report(env, url);
    if (p === '/admin/notes/delete' && m === 'POST') return deleteNote(req, env, null);
    if (p === '/admin/users' && m === 'GET') return listUsers(env);
    if (p === '/admin/users' && m === 'POST') return saveUser(req, env);
    if (p === '/admin/users/delete' && m === 'POST') return deleteUser(req, env);
    if (p === '/admin/log' && m === 'GET') return listLog(env, url);
    if (p === '/admin/log/clear' && m === 'POST') return clearLog(req, env);
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
  const u = await env.DB.prepare('SELECT id, name, role, sid, sidt, sidua FROM users WHERE rowid = ?').bind(t.rid).first();
  if (!u) fail('找不到這個使用者，請重新登入', 401);
  if (u.role === 'off') fail('這個帳號已被停用，請聯絡管理員', 401);
  const { sid, sidt, sidua, ...me } = u;
  // 有更新的登入：新憑證比對 sid；改版前的舊憑證沒有 sid，就看登入時間是不是比這張憑證晚
  if (sid && (t.sid ? t.sid !== sid : sidt > t.exp - USER_DAYS * 864e5)) me.other = { t: sidt, ua: sidua || '' };
  return me;
}

/* 登入的裝置，給「在其他瀏覽器登入」提醒用 */
function deviceOf(req) {
  const ua = req.headers.get('User-Agent') || '';
  const b = /Line\//.test(ua) ? 'LINE' : /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /SamsungBrowser/.test(ua) ? 'Samsung 瀏覽器'
    : /Firefox|FxiOS/.test(ua) ? 'Firefox' : /Chrome|CriOS/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : '瀏覽器';
  const o = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows'
    : /Mac OS/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
  return o ? b + '・' + o : b;
}

async function needAdmin(req, env) {
  const t = await readToken(req, env);
  if (!t || t.role !== 'admin') fail('請先登入後台', 401);
  const a = await env.DB.prepare('SELECT updated FROM admin WHERE id = 1').first();
  if (!a || a.updated !== t.v) fail('後台帳號或密碼已變更，請重新登入', 401);
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
  const sid = crypto.randomUUID(), now = Date.now();
  await env.DB.prepare('UPDATE users SET last = ?, sid = ?, sidt = ?, sidua = ? WHERE rowid = ?').bind(now, sid, now, deviceOf(req), u.rid).run();
  return { token: await makeToken(env, { role: 'user', rid: u.rid, sid }, USER_DAYS), me: { id: u.id, name: u.name, role: u.role } };
}

/* nx 下次聯絡日期、nn 跟進紀錄幾則、nl 最新一則（前 80 字） */
async function listStatus(env) {
  const { results } = await env.DB.prepare(`SELECT s.key, s.p, s.s, s.by, s.uid, s.t, s.name, s.addr, s.ind, s.ci, s.d, s.phone, s.nx, s.cn, s.cj, s.cm,
    (SELECT COUNT(*) FROM notes n WHERE n.key = s.key AND n.p = s.p) AS nn,
    (SELECT substr(n.text, 1, 80) FROM notes n WHERE n.key = s.key AND n.p = s.p ORDER BY n.id DESC LIMIT 1) AS nl
    FROM status s`).all();
  return results;
}

/* ---------- 跟進紀錄、下次聯絡日期（只有標記這家店的人可以寫）---------- */

async function ownStatus(env, me, key, p) {
  if (me.role === 'view') fail('你的權限只能查看，不能修改', 403);
  checkKey(key);
  const cur = await env.DB.prepare('SELECT uid, by FROM status WHERE key = ? AND p = ?').bind(key, p).first();
  if (!cur) fail('請先標記這家店的狀態，才能寫跟進紀錄', 400);
  if (cur.uid !== me.id) fail(`這筆是 ${cur.by} 標記的，只有本人可以寫跟進紀錄`, 403);
}

async function listNotes(env, url) {
  const key = str(url.searchParams.get('key'), 40), p = str(url.searchParams.get('p'), 20);
  checkKey(key);
  const { results } = await env.DB.prepare('SELECT id, uid, by, t, text FROM notes WHERE key = ? AND p = ? ORDER BY id DESC LIMIT 200').bind(key, p).all();
  return results;
}

async function addNote(req, env, me) {
  const b = await body(req);
  const key = str(b.key, 40), p = str(b.p, 20), text = str(b.text, NOTE_LEN);
  if (!text) fail('請輸入內容');
  await ownStatus(env, me, key, p);
  const now = Date.now();
  const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM notes WHERE uid = ? AND t > ?').bind(me.id, now - 3600e3).first();
  if (n >= MAX_NOTES_PER_HOUR) fail('新增太頻繁，請稍後再試', 429);
  const r = await env.DB.prepare('INSERT INTO notes (key, p, uid, by, t, text) VALUES (?,?,?,?,?,?)').bind(key, p, me.id, me.name, now, text).run();
  return { ok: true, id: r.meta.last_row_id, t: now, by: me.name, uid: me.id };
}

/* me 是 null＝後台，可以刪任何一則 */
async function deleteNote(req, env, me) {
  const id = parseInt((await body(req)).id, 10);
  const row = await env.DB.prepare('SELECT uid FROM notes WHERE id = ?').bind(id).first();
  if (!row) fail('找不到這則紀錄（可能已被刪除）', 404);
  if (me && row.uid !== me.id) fail('只能刪除自己寫的紀錄', 403);
  await env.DB.prepare('DELETE FROM notes WHERE id = ?').bind(id).run();
  return { ok: true };
}

async function setContact(req, env, me) {
  const b = await body(req);
  const key = str(b.key, 40), p = str(b.p, 20);
  await ownStatus(env, me, key, p);
  const cn = str(b.cn, 30), cj = str(b.cj, 30), cm = str(b.cm, 30);
  await env.DB.prepare('UPDATE status SET cn = ?, cj = ?, cm = ? WHERE key = ? AND p = ?').bind(cn || null, cj || null, cm || null, key, p).run();
  return { ok: true };
}

async function myNotes(env, me) {
  const { results } = await env.DB.prepare(`SELECT n.key, n.p, n.t, n.by, n.text FROM notes n
    JOIN status s ON s.key = n.key AND s.p = n.p WHERE s.uid = ? ORDER BY n.id`).bind(me.id).all();
  return results;
}

async function allNotes(env) {
  const { results } = await env.DB.prepare('SELECT key, p, t, by, uid, text FROM notes ORDER BY id').all();
  return results;
}

/* ---------- 每日推薦 ---------- */

async function getRecs(env, me) {
  const day = twDay();
  const { results } = await env.DB.prepare('SELECT key, p, name, addr, phone, ind, ci, d, why FROM recs WHERE day = ? AND uid = ? ORDER BY ord').bind(day, me.id).all();
  return { day, items: results };
}

async function makeRecs(req, env, me) {
  if (me.role !== 'user') fail('你的權限只能查看', 403);
  const b = await body(req);
  const cand = (Array.isArray(b.items) ? b.items : []).slice(0, 300);
  if (!cand.length) fail('沒有可以推薦的店家');
  const day = twDay(), since = twDay(Date.now() - REC_DAYS_OTHERS * 864e5);
  const keys = [...new Set(cand.map(c => str(c.key, 40)).filter(k => /^[csnwr]\d{1,20}$/.test(k)))];
  const busy = new Set();
  // 有人標記過（任何產品）、或最近推薦給別人的，都跳過；分批查，避免參數太多
  for (let i = 0; i < keys.length; i += 90) {
    const part = keys.slice(i, i + 90), q = part.map(() => '?').join(',');
    const a = await env.DB.prepare(`SELECT key FROM status WHERE key IN (${q})`).bind(...part).all();
    const r = await env.DB.prepare(`SELECT key FROM recs WHERE key IN (${q}) AND day >= ? AND uid != ?`).bind(...part, since, me.id).all();
    a.results.concat(r.results).forEach(x => busy.add(x.key));
  }
  // 換一批：今天推薦過、還沒標記的換掉；已經標記的留著
  const { results: mine } = await env.DB.prepare('SELECT key, p FROM recs WHERE day = ? AND uid = ?').bind(day, me.id).all();
  const old = new Set(mine.map(r => r.key));
  const pick = [];
  for (const c of cand) {
    const key = str(c.key, 40), p = str(c.p, 20);
    if (!p || !keys.includes(key) || busy.has(key) || old.has(key) || pick.some(x => x.key === key)) continue;
    pick.push({ key, p, name: str(c.name, 100), addr: str(c.addr, 200), phone: str(c.phone, 30), ind: str(c.ind, 30),
      ci: Number.isInteger(c.ci) ? c.ci : null, d: str(c.d, 10), why: str(c.why, 60) });
    if (pick.length >= REC_N) break;
  }
  if (!pick.length) fail('這個地區沒有新的店家可以推薦了，可以換個地區或產品');
  const stmts = [
    env.DB.prepare('DELETE FROM recs WHERE day < ?').bind(twDay(Date.now() - 30 * 864e5)),
    env.DB.prepare('DELETE FROM recs WHERE day = ? AND uid = ? AND key NOT IN (SELECT key FROM status)').bind(day, me.id),
  ];
  pick.forEach((c, i) => stmts.push(env.DB.prepare(`INSERT OR IGNORE INTO recs (day, uid, key, p, name, addr, phone, ind, ci, d, why, ord)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(day, me.id, c.key, c.p, c.name, c.addr, c.phone, c.ind, c.ci, c.d, c.why, 1000 + i)));
  await env.DB.batch(stmts);
  return getRecs(env, me);
}

/* ---------- 統計報表（後台）---------- */

async function report(env, url) {
  const since = parseInt(url.searchParams.get('since') || '0', 10) || 0;
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a).all().then(r => r.results);
  const [users, acts, notes, now, prods] = await Promise.all([
    q('SELECT id, name, role FROM users ORDER BY id'),
    q(`SELECT uid, s, COUNT(DISTINCT key || '|' || p) AS n FROM log WHERE t >= ? AND uid IS NOT NULL AND s != '' GROUP BY uid, s`, since),
    q('SELECT uid, COUNT(*) AS n FROM notes WHERE t >= ? GROUP BY uid', since),
    q('SELECT uid, s, COUNT(*) AS n FROM status GROUP BY uid, s'),
    q('SELECT p, s, COUNT(*) AS n FROM status GROUP BY p, s'),
  ]);
  return { users, acts, notes, now, prods };
}

async function setNext(req, env, me) {
  const b = await body(req);
  const key = str(b.key, 40), p = str(b.p, 20), nx = str(b.nx, 10);
  if (nx && !/^\d{4}-\d{2}-\d{2}$/.test(nx)) fail('日期格式錯誤');
  await ownStatus(env, me, key, p);
  await env.DB.prepare('UPDATE status SET nx = ? WHERE key = ? AND p = ?').bind(nx || null, key, p).run();
  return { ok: true };
}

function checkKey(key) {
  if (!/^[csnwr]\d{1,20}$/.test(key)) fail('店家代號錯誤');
}

/* 自行輸入的產品：請 AI 從現有產業裡挑「合作夥伴」「潛在客戶」 */
async function related(req, env) {
  const b = await body(req);
  const product = str(b.product, 20);
  if (!product) fail('請輸入產品');
  const inds = (Array.isArray(b.inds) ? b.inds : []).slice(0, 300).map(x => str(x, 30)).filter(Boolean);
  if (!inds.length) fail('缺少產業清單');
  const pick = a => [...new Set((Array.isArray(a) ? a : []).map(x => String(x).trim()))].filter(x => inds.includes(x)).slice(0, 20);
  const row = await env.DB.prepare('SELECT partner, client FROM related WHERE p = ?').bind(product).first();
  if (row) return { partner: pick(JSON.parse(row.partner)), client: pick(JSON.parse(row.client)) };
  const now = Date.now();
  const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM related WHERE t > ?').bind(now - 3600e3).first();
  if (n >= MAX_AI_PER_HOUR) fail('查詢太頻繁，請稍後再試', 429);
  const prompt = `我在台灣賣「${product}」，要開發客戶。下面是可以列出店家名單的產業：
${inds.join('、')}

請只從上面的產業裡挑出：
- client 潛在客戶：會買「${product}」放在自己店裡使用、提供給客人用，或進貨來賣的店家（先想這一類）
- partner 合作夥伴：自己不太會買「${product}」，但服務的客人剛好也會需要「${product}」，可以互相介紹客人或一起接案的店家（例如裝潢、設計、相關服務業）
各挑 8～18 個，盡量多找可以開發的，關聯最強的排前面；完全無關的才不要選，同一個產業不要兩邊都放。名稱要和清單完全一樣。
只回 JSON，不要其他文字：{"client":["…"],"partner":["…"]}`;
  let out;
  try {
    out = await env.AI.run(AI_MODEL, { messages: [{ role: 'user', content: prompt }], max_tokens: 3000, temperature: 0.2, reasoning: { effort: 'low' } });
  } catch (e) { fail('AI 暫時無法使用，請稍後再試', 503); }
  const res = out?.response ?? out?.choices?.[0]?.message?.content ?? '';
  let j = typeof res === 'object' && res ? res : {};
  if (typeof res === 'string') {
    try { j = JSON.parse(res.replace(/<think>[\s\S]*?<\/think>/, '').match(/\{[\s\S]*\}/)[0]); } catch (e) { /* 下面當作沒結果 */ }
  }
  const partner = pick(j.partner), client = pick(j.client).filter(x => !partner.includes(x));
  if (!partner.length && !client.length) fail('沒有找到相關產業，可以換個說法再試');
  await env.DB.prepare('INSERT OR REPLACE INTO related (p, partner, client, t) VALUES (?,?,?,?)')
    .bind(product, JSON.stringify(partner), JSON.stringify(client), now).run();
  return { partner, client };
}

async function saveStatus(req, env, me) {
  if (me.role === 'view') fail('你的權限只能查看，不能標記', 403);
  const b = await body(req);
  const key = str(b.key, 40), p = str(b.p, 20), s = str(b.s, 10);
  checkKey(key);
  if (s && !STATUSES.includes(s)) fail('狀態錯誤');
  if (s && !p) fail('缺少產品');
  // 一般權限只能改、取消自己標的；後台改過的（沒有標記人）只有後台能動
  const cur = await env.DB.prepare('SELECT uid, by FROM status WHERE key = ? AND p = ?').bind(key, p).first();
  if (cur && cur.uid !== me.id) fail(`這筆是 ${cur.by} 標記的，只有本人或後台可以修改`, 403);
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

/* 密碼雜湊：PBKDF2-SHA256，10 萬次 */
async function hashPw(pw, saltHex) {
  const salt = Uint8Array.from(saltHex.match(/../g), x => parseInt(x, 16));
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256);
  return b64u(bits);
}
const newSalt = () => [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');

/* 後台帳號；還沒設定過就用 admin＋ADMIN_PASSWORD 建立 */
async function getAdmin(env) {
  let a = await env.DB.prepare('SELECT username, salt, hash, updated FROM admin WHERE id = 1').first();
  if (!a) {
    if (!env.ADMIN_PASSWORD) fail('伺服器尚未設定 ADMIN_PASSWORD', 500);
    const salt = newSalt();
    a = { username: 'admin', salt, hash: await hashPw(env.ADMIN_PASSWORD, salt), updated: Date.now() };
    await env.DB.prepare('INSERT OR IGNORE INTO admin (id, username, salt, hash, updated) VALUES (1,?,?,?,?)').bind(a.username, a.salt, a.hash, a.updated).run();
    a = await env.DB.prepare('SELECT username, salt, hash, updated FROM admin WHERE id = 1').first();
  }
  return a;
}

async function adminLogin(req, env) {
  const ip = ipOf(req);
  await guardLogin(env, ip);
  const b = await body(req);
  const username = str(b.username, 40), pw = str(b.password, 100);
  if (!username || !pw) fail('請輸入使用者名稱和密碼');
  const a = await getAdmin(env);
  const ok = username.toLowerCase() === a.username.toLowerCase() && await hashPw(pw, a.salt) === a.hash;
  await noteLogin(env, ip, ok, '(後台) ' + username);
  if (!ok) fail('使用者名稱或密碼錯誤', 403);
  return { token: await makeToken(env, { role: 'admin', v: a.updated }, ADMIN_DAYS), username: a.username };
}

async function saveAccount(req, env) {
  const b = await body(req);
  const a = await getAdmin(env);
  if (await hashPw(str(b.current, 100), a.salt) !== a.hash) fail('目前的密碼不正確', 403);
  const username = str(b.username, 40) || a.username;
  const pw = str(b.password, 100);
  if (pw && pw.length < 6) fail('新密碼至少要 6 個字');
  const salt = pw ? newSalt() : a.salt;
  const hash = pw ? await hashPw(pw, salt) : a.hash;
  const updated = Date.now();
  await env.DB.prepare('UPDATE admin SET username = ?, salt = ?, hash = ?, updated = ? WHERE id = 1').bind(username, salt, hash, updated).run();
  return { ok: true, username, token: await makeToken(env, { role: 'admin', v: updated }, ADMIN_DAYS) };
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
  const { results } = await env.DB.prepare(`SELECT u.id, u.name, u.role, u.created, u.last, u.sidua,
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
    env.DB.prepare('UPDATE notes SET uid = ?, by = ? WHERE uid = ?').bind(id, name, oldId),
    env.DB.prepare('UPDATE recs SET uid = ? WHERE uid = ?').bind(id, oldId),
  ]);
  return { ok: true };
}

async function deleteUser(req, env) {
  const id = str((await body(req)).id, 20);
  await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
  return { ok: true };
}

async function listLog(env, url) {
  const before = parseInt(url.searchParams.get('before') || '0', 10) || 2 ** 52;
  const since = parseInt(url.searchParams.get('since') || '0', 10) || 0;
  const { results } = await env.DB.prepare('SELECT id, key, p, s, by, uid, t, name FROM log WHERE id < ? AND t >= ? ORDER BY id DESC LIMIT 200')
    .bind(before, since).all();
  const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM log WHERE t >= ?').bind(since).first();
  return { items: results, total: n };
}

async function clearLog(req, env) {
  const since = parseInt((await body(req)).since, 10) || 0;
  const r = await env.DB.prepare('DELETE FROM log WHERE t >= ?').bind(since).run();
  return { ok: true, deleted: r.meta.changes };
}
