-- 2026-10-21：後台帳號（使用者名稱＋密碼雜湊），只有一筆
CREATE TABLE IF NOT EXISTS admin (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  username TEXT NOT NULL,
  salt TEXT NOT NULL,
  hash TEXT NOT NULL,       -- PBKDF2-SHA256
  updated INTEGER NOT NULL  -- 改帳密時更新，舊的後台登入會失效
);
