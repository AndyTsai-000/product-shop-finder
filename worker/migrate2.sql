-- 2026-10-21：使用者名單（只用名字登入）與登入紀錄
CREATE TABLE IF NOT EXISTS users (
  name TEXT PRIMARY KEY,
  active INTEGER NOT NULL DEFAULT 1,
  created INTEGER,
  last INTEGER              -- 最後登入時間
);
CREATE TABLE IF NOT EXISTS logins (ip TEXT, t INTEGER, ok INTEGER, who TEXT);
CREATE INDEX IF NOT EXISTS logins_ip_t ON logins(ip, t);
