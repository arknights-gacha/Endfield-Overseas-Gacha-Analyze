# Endfield Gacha Analyzer - Agent Context 指南

這份 `agent.md` 的目的是為了幫助後續接手的 AI Agent 或真人開發者，能夠快速且無縫地載入整個 `Firebase-endfieldgacha` 專案的上下文（Context），避免重複踩坑並維持架構一致性。

---

## 📌 1. Project Overview & Context (專案概述與當前上下文)

**核心目標**：
本專案為「明日方舟：終末地 (Arknights: Endfield)」專用的抽卡紀錄分析與視覺化工具。透過與官方 Gryphline 服務介接，獲取玩家的尋訪紀錄，並在不持久化保存敏感個人資訊的前提下，提供深度的抽卡統計（各卡池出金率、平均抽數、保底墊抽數等）。

**技術棧 (Tech Stack)**：
*   **後端**：Node.js + Firebase Cloud Functions + Express。
*   **前端**：EJS 樣板引擎 + Vanilla JS/CSS（零前端框架，追求極致輕量化與快速渲染）。
*   **儲存**：Firestore（僅用於快取與匿名化統計）。授權憑證**不寫入資料庫** —— 它只存在於已簽章的 httpOnly `__session` cookie 中（見下方第 4 節的不可違反原則 7）。
*   **輔助工具**：Chromium 擴充功能 (`Endfield-Overseas-Gacha-Helper-Extension`)，負責從官方網頁中安全提取 `X-Role-Token` 與登入 Cookie。

**當前系統最新狀態**：
*   已完成全面 SEO 優化（於全域注入 Canonical URL、更新 Login 頁面 Meta 內容）。
*   已完成各卡池的「獨立統計與渲染」架構（角色池與武器池完全拆分）。
*   已對齊並修正終末地特有的星級邏輯：包含武器池在內，最高稀有度（出金）皆為 6 星。
*   **（2026-10-16）P0-8 完成**：新增「重構尋訪」抓取；分類改為抓取時標記 `poolType`；顯示層改為資料驅動；重構尋訪保底改以「同名」累積。
*   **（2026-10-16）P0-9 完成**：授權憑證只存在 httpOnly cookie，不經手 Firestore；新增 uid consistency check 與抓取互斥鎖。

**本機驗證腳本**（`scripts/`，在工作區根目錄執行）：
```bash
npm --prefix Firebase-endfieldgacha/functions install   # node_modules 會被 postdeploy hook 清掉，本機要自己裝
node Firebase-endfieldgacha/scripts/regression-check.js # 用 gacha-backup/ 快照比對 analyzeLogs 輸出（--update 重設基準）
node Firebase-endfieldgacha/scripts/pity-cases.js       # 重構尋訪的分類與保底案例（合成資料）
node Firebase-endfieldgacha/scripts/flow-check.js       # 登入／抓取流程端到端，稽核權杖從不進 Firestore
```

---

## 🏗️ 2. Architecture & Core Concepts (架構與核心概念)

### 核心目錄與職責
*   `functions/index.js`：應用的進入點。負責初始化 Express、定義所有 API 路由 (`/login`, `/privacy`, `/api/log` 等)、處理跨域 (CORS) 以及中介軟體 (Middleware，如 SEO Canonical URL)。
*   `functions/utils.js`：核心業務邏輯的重鎮。包含向 Gryphline API 發送請求的 `fetchLogsByPool`，以及最關鍵的 `analyzeLogs`（負責計算保底、分類卡池、處理贈送抽邏輯）。
*   `functions/views/`：
    *   `login.ejs`：Landing Page，負責引導使用者安裝擴充功能或進行登入，包含完整的工具介紹與 SEO 內容。
    *   `index.ejs`：資料展示的儀表板 (Dashboard)。採用動態迴圈 (`categoriesArr.forEach`) 渲染各卡池狀態，並具備全域底部懸浮選單 (Footer Menu)。
    *   `privacy.ejs`：隱私權政策聲明頁面。

### 核心架構決策 (Architecture Decisions)
1.  **無狀態架構與隱私優先**：伺服器端不保存憑證。抓取需要跨請求續傳（`selectRole` 必須搶在 Hosting 的 60 秒逾時前回應，慢速爬取交給 `/fetch-logs`），所以授權憑證存放在**已簽章的 httpOnly `__session` cookie**，而非資料庫或 Function 實例的記憶體 —— 這同時保證任何 instance 都能接手（真正的無狀態），且頁面 JS 讀不到。抓取完成後由 `/check-ready` 清除。
2.  **角色識別 (Role-based Indexing)**：由於 Gryphline 帳號支援跨服多角色，資料庫索引與快取機制必須使用 `data-list-bindingList-roles-[角色]-roleId`（例如 `4677200022`）作為主鍵，而非頂層的帳號 UID。

---

## 🚦 3. Development Guidelines (開發與上手指南)

**本地啟動與測試**：
1.  **安裝依賴**：切換至 `functions/` 目錄並執行 `npm install`。
2.  **啟動 Firebase 模擬器**：執行 `firebase emulators:start` 啟動本地測試伺服器（通常運行於 `localhost:5000`）。
3.  **除錯建議**：若需測試 API 抓取邏輯，可從擴充功能攔截一組有效的 Token，利用 Postman 或本地腳本直接打 Localhost API。
4.  **部署上線**：確認無誤後，使用 `firebase deploy --only functions,hosting` 進行部署。

**代碼風格**：
*   **前端**：盡量維持 Vanilla JS，CSS 樣式可寫在樣板的 `<style>` 中，避免過早引入大型建置工具（如 Webpack/Vite）。
*   **後端**：維持無狀態 (Stateless)，確保所有的暫存與運算都不依賴特定的 Function 實例。

---

## ⚠️ 4. Trade-offs & Pitfalls (權衡取捨與已知陷阱)

在接手本專案時，請務必注意以下「雷區」與設計限制：

1.  **星級邏輯與武器池陷阱 (Critical Pitfall)**：
    *   **不要**假設武器最高只有 5 星。終末地的武器池（武庫申領）**同樣擁有 6 星項目**。
    *   在 `utils.js` 中判斷出金（重置保底）的邏輯必須統一為：`const isGold = (rarity === "6");`。
2.  **贈送抽 (Free Pulls) 的處理**：
    *   卡池中會出現「不計保底」的贈送抽，其欄位為 `item.isFree`（布林值）。
    *   **限制**：如果 `isFree === true`，該抽**絕對不可以**計入 `countAcc`（累計墊抽數）。如果抽出的 6 星是贈送抽，則不需要顯示耗費抽數（但仍須出現在「近期出金」列表中）。
3.  **獨立卡池的統計**：
    *   終末地卡池共 6 類真實分類：`特許尋訪`、`基礎尋訪`、`重構尋訪`、`輝光慶典`、`啟程尋訪`、`武庫申領`，外加一個診斷用的 `其他尋訪`。
    *   **分類與順序的唯一來源是 `utils.js` 的 `ALL_CATEGORIES`**。`index.ejs` 以 `Object.keys(stats.starcounts)` 推導按鈕列、面板與預設分類 —— **不要在樣板裡硬編碼分類清單**。
    *   **不要**嘗試把所有卡池的保底與抽數混在一起算。在 `index.ejs` 中，我們已經改為迴圈遍歷各卡池獨立渲染，請維持這個模式。

4.  ⚠️ **`其他尋訪` 的真實作用範圍（別高估它）**
    *   它**必須存在於 `ALL_CATEGORIES`**，否則 `categoryOf()` 回傳的分類在 `starcounts` 裡查不到，`starcounts[category][rarity]++` 會對 `undefined` 取下標而讓整個 dashboard 爆掉。這是它最實際的功能：保證 `categoryOf` 有回傳值。
    *   它**只在真的有紀錄時才對使用者顯示**（`index.ejs` 用 `stats.unknownCategory` 過濾），因為它不是真實卡池，常駐顯示只會給每個人一個空頁籤。
    *   **什麼會進去**：角色紀錄的 `poolId` 不符任何已知前綴、`poolId` 缺失或型別異常、或連 `itemCategory` 都沒有的紀錄。實務上真正會觸發的是 **`index.js` 的 `method === 'upload'` 這條零驗證路徑**（直接存 `req.body.logs`），以及從 `gacha-backup/` 還原或他人工具導出的 JSON。
    *   **什麼永遠不會進去**：任何武器紀錄（`categoryOf` 第一行無條件回 `武庫申領`）；任何正常抓取的角色紀錄（抓取時一定被標上 5 個 enum 之一，而那 5 個都有對應分類）。
    *   🔴 **所以它不是「新卡池型態」的安全網 —— 這點務必分清**：
        *   **武器側確實免疫**：我們不帶 `pool_id` 分頁到底，新武器池自動被抓到並歸入 `武庫申領`。
        *   **角色側不免疫**：角色 API **強制要求** `pool_type`，我們只拿得到明確請求過的 enum 的紀錄。一個還不知道的新型態 → **根本沒有紀錄會進來** → 也不會落到 `其他尋訪`。
        *   角色側新卡池的真正防線是**發現新 enum 並加進 `CHAR_POOL_TYPES`**，也就是下方第 6 點的探測機制。而 `GET /api/record/char/pool` 回空陣列、無法列舉型態，所以**只能靠定期重跑探測，沒有自動發現的辦法**。
        *   ⚠️ **這是目前仍未解決的殘餘風險** —— 「重構尋訪」當初整個漏掉的根因就在抓取層，而顯示層資料驅動只解決了「已抓到但分類未知的東西要看得見」這一半。
5.  **防爬蟲與併發限制**：
    *   向官方獲取資料的 `fetchAllLogsSlowly` 等函數中，刻意保留了 `sleep(200)` 等延遲機制，這是為了避免觸發官方 API 的 Rate Limit 或 WAF 阻擋。**請勿**為了追求速度而移除這些延遲。
6.  **卡池型態的發現機制（可重複使用）**：
    *   API 對 `pool_type` 做應用層驗證，回應本身就是一個判定機制：<br>`code: 0` = enum 有效（**即使該帳號 0 筆也是 0**）／`code: 40000 "Invalid pool_type"` = enum 無效／`HTTP 400` = 參數型別或空值錯誤。
    *   據此探測 66 個候選名稱，**只有 5 個有效**，即 `utils.js` 的 `CHAR_POOL_TYPES`。大小寫敏感。
    *   角色側**強制要求** `pool_type`（不帶會回 400），所以無法用「省略參數」聚合全部卡池。武器側則相反，不帶 `pool_id` 分頁到底就是完整結果（已驗證 = 逐池列舉）。
    *   另有兩個端點：`GET /api/record/weapon/pool` 回傳武器卡池註冊表（`poolId` / `poolName` / `poolType` 為 `normal`｜`rerun` / `online`），我們用它標記武器側的重構池；`GET /api/record/char/pool` 存在但 `data` 為空陣列，**無法**用來列舉角色卡池。

7.  🔴 **不可違反：憑證絕不可寫入受 BigQuery extension 監聽的文件**
    *   Firebase Console 上的 `firestore-bigquery-export` extension 設定為 `COLLECTION_PATH=endfieldUsers` —— **直接監聽使用者文件**，且 `EXCLUDE_OLD_DATA=no`。
    *   寫進受監聽文件的任何欄位都是**永久的**：changelog 的 `old_data` 連被刪掉的欄位都會保留，`FieldValue.delete()` 救不回來。
    *   所以 `endfieldUsers/{roleId}` 只能放不敏感內容（`info` 與 `fetchStartedAt` / `lastFetchedAt` 時間戳）。憑證一律走 `__session` cookie（`index.js` 的 `getSession` / `setSession`）。
    *   extension 設定由 Firebase Console 管理，**不納入本 repo**（BigQuery 匯出屬於獨立的分析工作流，`.gitignore` 已排除 `extensions/`）。設定快照在工作區的 `datastudio/firestore-bigquery-export.env`，不會自動跟隨 Console，變更後需手動 `firebase ext:export` 同步。任何 `firebase ext:*` 指令都會把 `etags` 寫回 `.firebaserc`，提交前請檢查 `git diff .firebaserc`。

8.  ⚠️ **新增的 API 欄位不可單獨作為演算法依據**
    *   舊紀錄沒有新欄位。任何依賴新欄位的判斷都**必須明確定義「欄位不存在」時的行為**。
    *   既有範例：`utils.js` 的 `logs.filter(item => !item.kind || item.kind === "draw")` —— `!item.kind` 正是為了保留沒有 `kind` 的舊紀錄；`categoryOf()` 在沒有 `poolType` 時退回 poolId 前綴；`isRerun()` 同理。
    *   已知的欄位斷代：`isFree` 在 2026-04-21 的備份裡**還沒有**（5-19 才有）；`kind` 在兩份備份裡都沒有；`poolVersion` 雖然存在但**實測恆為 `null`**，不要拿它當判斷依據。
    *   ⚠️ **官方 API 只保留約 3 個月的紀錄**（實測最早一律是當下往前推約 3 個月），超窗歷史**不可重建**，只存在於 Firestore 與 `gacha-backup/`。所以 `mergeLogs` 的純聯集語意很重要，任何破壞性 DB 操作都是永久損失。

9.  ⏳ **待查證**：重構尋訪的每抽成本是否同為 500 嵌晶玉。`index.ejs` 的 `POOL_COST` 目前讓它走 500 的預設值（只有 `武庫申領` 是 198 武庫配額）。需要有該卡池紀錄的帳號或官方資料確認。

10. **與 Arknights (明日方舟) 的差異**：
    *   如果您同時維護 `Firebase-global-arknightsgacha`，請注意明日方舟的官方 API 星級可能是從 0 開始索引的（即 `5` 代表 6 星），但**終末地的 API 是真實星級**（`6` 就是 6 星）。**不要**將明日方舟的 `lastCounts['5']` 邏輯直接複製到本專案中。
