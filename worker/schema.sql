-- 每家店目前的狀態（key：c/s+統編，或 OSM 代號）
CREATE TABLE IF NOT EXISTS status (
  key TEXT NOT NULL,
  p TEXT NOT NULL DEFAULT '', -- 產品（每個產品各自一筆狀態）
  s TEXT NOT NULL,          -- call 已電聯 / visit 已拜訪 / no 無意願 / deal 合作中
  by TEXT,                  -- 標記人
  t INTEGER NOT NULL,       -- 更新時間（毫秒）
  name TEXT, addr TEXT, ind TEXT, ci INTEGER, d TEXT, phone TEXT,
  PRIMARY KEY (key, p)
);
-- 修改紀錄（誤改時可以查回來）
CREATE TABLE IF NOT EXISTS log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT, s TEXT, by TEXT, t INTEGER, name TEXT, ip TEXT, p TEXT
);
CREATE INDEX IF NOT EXISTS log_t ON log(t);
