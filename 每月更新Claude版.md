每月更新「產品找店家」的 Claude 網頁版。

GitHub 版（https://andytsai-000.github.io/product-shop-finder/）由 Windows 工作排程器「產品找店家每月更新」在每月 6 日 09:00 自動更新，這份說明只負責把同一份資料同步到 Claude 版。請在每月 6 日 11:00 之後執行。

步驟：
1. 讀 D:\Webproject\產品找店家\update.log 的最後一行。
   - 如果不是本月的「已更新並上傳」或「資料沒有變動」，回報那一行內容後結束，不要發布。
   - 如果是「資料沒有變動」，回報後結束。
2. 列出 D:\Webproject\產品找店家\site\data 裡所有 .json 檔。
3. 用 Artifact 工具重新發布到既有網址（一定要帶 url）：
   - url: https://claude.ai/artifact/D4Wd9uN3CUVkDyTgsbrsMQ
   - file_path: D:\Webproject\產品找店家\site\index.html
   - root: D:\Webproject\產品找店家\site
   - files: 每個檔案一筆 {"path": "data/<檔名>"}（全部都要帶）
   - 不要傳 capabilities、icon、contract。
   發布前若被要求先讀取，就用 Artifact action "read" 讀一次再發布；index.html 本身不用修改。
4. 用繁體中文簡短回報：update.log 最後一行、網頁連結。
