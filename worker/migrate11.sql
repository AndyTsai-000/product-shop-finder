-- 每週目標／報表：標了又取消的不算，要查每個人每家店最後一筆
CREATE INDEX IF NOT EXISTS log_ukp ON log(uid, key, p, t);
