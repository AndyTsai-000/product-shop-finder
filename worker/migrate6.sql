-- 每個使用者最後一次登入的憑證代號、時間、裝置（同帳號在別的瀏覽器登入時提醒）
ALTER TABLE users ADD COLUMN sid TEXT;
ALTER TABLE users ADD COLUMN sidt INTEGER;
ALTER TABLE users ADD COLUMN sidua TEXT;
