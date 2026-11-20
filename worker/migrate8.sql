-- 2026-11-20：聯絡窗口＋每日推薦
ALTER TABLE status ADD COLUMN cn TEXT;   -- 聯絡人姓名
ALTER TABLE status ADD COLUMN cj TEXT;   -- 職稱
ALTER TABLE status ADD COLUMN cm TEXT;   -- 聯絡人手機
CREATE TABLE IF NOT EXISTS recs (
  day TEXT NOT NULL,        -- 台灣日期 YYYY-MM-DD
  uid TEXT NOT NULL,        -- 推薦給誰
  key TEXT NOT NULL, p TEXT NOT NULL,
  name TEXT, addr TEXT, phone TEXT, ind TEXT, ci INTEGER, d TEXT,
  why TEXT,                 -- 推薦原因
  ord INTEGER,              -- 排序
  PRIMARY KEY (day, key, p)
);
CREATE INDEX IF NOT EXISTS recs_uid ON recs(uid, day);
CREATE INDEX IF NOT EXISTS recs_key ON recs(key, day);
