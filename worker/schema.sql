-- 每家店目前的狀態（key：c/s+統編，或 OSM 代號）
CREATE TABLE IF NOT EXISTS status (
  key TEXT NOT NULL,
  p TEXT NOT NULL DEFAULT '', -- 產品（每個產品各自一筆狀態）
  g TEXT NOT NULL DEFAULT '', -- 組別（每個組別各自一筆，不同組看不到彼此）
  s TEXT NOT NULL,          -- call 已電聯 / visit 已拜訪 / no 無意願 / deal 合作中
  by TEXT,                  -- 標記人
  t INTEGER NOT NULL,       -- 更新時間（毫秒）
  name TEXT, addr TEXT, ind TEXT, ci INTEGER, d TEXT, phone TEXT,
  uid TEXT,                   -- 標記人編號
  nx TEXT,                    -- 下次聯絡日期 YYYY-MM-DD
  cn TEXT, cj TEXT, cm TEXT,  -- 聯絡窗口：姓名、職稱、手機
  PRIMARY KEY (key, p, g)
);
CREATE INDEX IF NOT EXISTS status_g ON status(g);
-- 修改紀錄（誤改時可以查回來）
CREATE TABLE IF NOT EXISTS log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT, s TEXT, by TEXT, t INTEGER, name TEXT, ip TEXT, p TEXT, uid TEXT, g TEXT
);
CREATE INDEX IF NOT EXISTS log_t ON log(t);
-- 使用者（編號＋姓名登入）
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,                -- 使用者編號（登入用）
  name TEXT NOT NULL,                 -- 姓名（登入用，也顯示在狀態上）
  role TEXT NOT NULL DEFAULT 'user',  -- user 一般／view 檢視／off 停用
  grp TEXT NOT NULL DEFAULT '',       -- 組別（空白＝未分組）
  created INTEGER,
  last INTEGER,
  sid TEXT, sidt INTEGER, sidua TEXT -- 最後一次登入的憑證代號、時間、裝置（同帳號在別的瀏覽器登入時提醒）
);
CREATE TABLE IF NOT EXISTS logins (ip TEXT, t INTEGER, ok INTEGER, who TEXT);
CREATE INDEX IF NOT EXISTS logins_ip_t ON logins(ip, t);
-- 2026-10-21：後台帳號（使用者名稱＋密碼雜湊），只有一筆
CREATE TABLE IF NOT EXISTS admin (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  username TEXT NOT NULL,
  salt TEXT NOT NULL,
  hash TEXT NOT NULL,       -- PBKDF2-SHA256
  updated INTEGER NOT NULL  -- 改帳密時更新，舊的後台登入會失效
);
-- 2026-10-22：自行輸入的產品 → AI 判斷的相關產業（同一個產品只問一次）
CREATE TABLE IF NOT EXISTS related (
  p TEXT PRIMARY KEY,   -- 產品
  partner TEXT,         -- 合作夥伴產業（JSON 陣列）
  client TEXT,          -- 潛在客戶產業（JSON 陣列）
  t INTEGER
);
-- 2026-11-20：跟進紀錄（每家店在每個產品下可以寫多則備註）
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL, p TEXT NOT NULL DEFAULT '',
  uid TEXT, by TEXT, t INTEGER NOT NULL, text TEXT NOT NULL,
  g TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS notes_kpg ON notes(key, p, g);
CREATE TABLE IF NOT EXISTS recs (
  day TEXT NOT NULL,        -- 台灣日期 YYYY-MM-DD
  uid TEXT NOT NULL,        -- 推薦給誰
  g TEXT NOT NULL DEFAULT '', -- 他的組別
  key TEXT NOT NULL, p TEXT NOT NULL,
  name TEXT, addr TEXT, phone TEXT, ind TEXT, ci INTEGER, d TEXT,
  why TEXT,                 -- 推薦原因
  ord INTEGER,              -- 排序
  PRIMARY KEY (day, uid, key)
);
CREATE INDEX IF NOT EXISTS recs_uid ON recs(uid, day);
CREATE INDEX IF NOT EXISTS recs_key ON recs(key, day);
