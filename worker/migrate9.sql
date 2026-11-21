-- 2026-11-21：組別。同組的同事互相看得到狀態、跟進紀錄、下次聯絡、聯絡窗口；不同組完全看不到。
-- 每家店在每個產品下，每個組別各自一筆狀態（主鍵加上 g），兩組標同一家不會互相蓋掉。
-- 現有資料全部放在「未分組」（g = ''），套用後行為和原本一樣，直到後台幫使用者設定組別。
ALTER TABLE users ADD COLUMN grp TEXT NOT NULL DEFAULT '';

CREATE TABLE status_new (
  key TEXT NOT NULL,
  p TEXT NOT NULL DEFAULT '',
  g TEXT NOT NULL DEFAULT '',
  s TEXT NOT NULL,
  by TEXT,
  t INTEGER NOT NULL,
  name TEXT, addr TEXT, ind TEXT, ci INTEGER, d TEXT, phone TEXT,
  uid TEXT,
  nx TEXT,
  cn TEXT, cj TEXT, cm TEXT,
  PRIMARY KEY (key, p, g)
);
INSERT INTO status_new (key, p, g, s, by, t, name, addr, ind, ci, d, phone, uid, nx, cn, cj, cm)
  SELECT key, p, '', s, by, t, name, addr, ind, ci, d, phone, uid, nx, cn, cj, cm FROM status;
DROP TABLE status;
ALTER TABLE status_new RENAME TO status;
CREATE INDEX IF NOT EXISTS status_g ON status(g);

ALTER TABLE notes ADD COLUMN g TEXT NOT NULL DEFAULT '';
DROP INDEX IF EXISTS notes_kp;
CREATE INDEX IF NOT EXISTS notes_kpg ON notes(key, p, g);

CREATE TABLE recs_new (
  day TEXT NOT NULL, uid TEXT NOT NULL, g TEXT NOT NULL DEFAULT '',
  key TEXT NOT NULL, p TEXT NOT NULL,
  name TEXT, addr TEXT, phone TEXT, ind TEXT, ci INTEGER, d TEXT,
  why TEXT, ord INTEGER,
  PRIMARY KEY (day, uid, key)
);
INSERT OR IGNORE INTO recs_new (day, uid, g, key, p, name, addr, phone, ind, ci, d, why, ord)
  SELECT day, uid, '', key, p, name, addr, phone, ind, ci, d, why, ord FROM recs;
DROP TABLE recs;
ALTER TABLE recs_new RENAME TO recs;
CREATE INDEX IF NOT EXISTS recs_uid ON recs(uid, day);
CREATE INDEX IF NOT EXISTS recs_key ON recs(key, day);

ALTER TABLE log ADD COLUMN g TEXT;
