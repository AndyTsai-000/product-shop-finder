-- 每家店目前的狀態（key：c/s+統編，或 OSM 代號）
CREATE TABLE IF NOT EXISTS status (
  key TEXT NOT NULL,
  p TEXT NOT NULL DEFAULT '', -- 產品（每個產品各自一筆狀態）
  s TEXT NOT NULL,          -- call 已電聯 / visit 已拜訪 / no 無意願 / deal 合作中
  by TEXT,                  -- 標記人
  t INTEGER NOT NULL,       -- 更新時間（毫秒）
  name TEXT, addr TEXT, ind TEXT, ci INTEGER, d TEXT, phone TEXT,
  uid TEXT,                   -- 標記人編號
  PRIMARY KEY (key, p)
);
-- 修改紀錄（誤改時可以查回來）
CREATE TABLE IF NOT EXISTS log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT, s TEXT, by TEXT, t INTEGER, name TEXT, ip TEXT, p TEXT, uid TEXT
);
CREATE INDEX IF NOT EXISTS log_t ON log(t);
-- 使用者（編號＋姓名登入）
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,                -- 使用者編號（登入用）
  name TEXT NOT NULL,                 -- 姓名（登入用，也顯示在狀態上）
  role TEXT NOT NULL DEFAULT 'user',  -- lead 主管／user 一般／view 檢視／off 停用
  created INTEGER,
  last INTEGER
);
CREATE TABLE IF NOT EXISTS logins (ip TEXT, t INTEGER, ok INTEGER, who TEXT);
CREATE INDEX IF NOT EXISTS logins_ip_t ON logins(ip, t);
