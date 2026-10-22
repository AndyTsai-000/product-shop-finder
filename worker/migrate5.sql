-- 2026-10-22：自行輸入的產品 → AI 判斷的相關產業（同一個產品只問一次）
CREATE TABLE IF NOT EXISTS related (
  p TEXT PRIMARY KEY,   -- 產品
  partner TEXT,         -- 合作夥伴產業（JSON 陣列）
  client TEXT,          -- 潛在客戶產業（JSON 陣列）
  t INTEGER
);
