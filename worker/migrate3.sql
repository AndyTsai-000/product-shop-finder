-- 2026-10-21：使用者改成「編號＋姓名」登入，加上權限；狀態與紀錄記下標記人編號
DROP TABLE IF EXISTS users;
CREATE TABLE users (
  id TEXT PRIMARY KEY,                -- 使用者編號（登入用）
  name TEXT NOT NULL,                 -- 姓名（登入用，也顯示在狀態上）
  role TEXT NOT NULL DEFAULT 'user',  -- lead 主管／user 一般／view 檢視／off 停用
  created INTEGER,
  last INTEGER                        -- 最後登入時間
);
ALTER TABLE status ADD COLUMN uid TEXT;
ALTER TABLE log ADD COLUMN uid TEXT;
