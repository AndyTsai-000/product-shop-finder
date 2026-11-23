-- 2026-11-23：地圖座標、店家回報（已歇業／電話錯誤／地址找不到）、每週目標
ALTER TABLE status ADD COLUMN la REAL;
ALTER TABLE status ADD COLUMN lo REAL;
CREATE TABLE IF NOT EXISTS flags (
  key TEXT NOT NULL,
  g TEXT NOT NULL DEFAULT '',  -- 組別（同組才看得到）
  f TEXT NOT NULL,             -- closed 已歇業／phone 電話錯誤／addr 地址找不到
  uid TEXT, by TEXT, t INTEGER NOT NULL,
  name TEXT, addr TEXT,
  PRIMARY KEY (key, g)
);
CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT);
