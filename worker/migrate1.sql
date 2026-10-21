-- 2026-10-21：狀態改成「每個產品各自一筆」，主鍵 (key, p)；舊資料 p='' 保留
CREATE TABLE status2 (
  key TEXT NOT NULL,
  p TEXT NOT NULL DEFAULT '',  -- 產品（家具、窗簾…），空字串＝改版前的舊資料
  s TEXT NOT NULL, by TEXT, t INTEGER NOT NULL,
  name TEXT, addr TEXT, ind TEXT, ci INTEGER, d TEXT, phone TEXT,
  PRIMARY KEY (key, p)
);
INSERT INTO status2 (key, p, s, by, t, name, addr, ind, ci, d, phone)
  SELECT key, '', s, by, t, name, addr, ind, ci, d, phone FROM status;
DROP TABLE status;
ALTER TABLE status2 RENAME TO status;
ALTER TABLE log ADD COLUMN p TEXT;
