# Endfield Gacha Analyzer - Agent Context 指南

這份 `agent.md` 的目的是為了幫助後續接手的 AI Agent 或真人開發者，能夠快速且無縫地載入整個 `Firebase-endfieldgacha` 專案的上下文（Context），避免重複踩坑並維持架構一致性。

---

## 📌 1. Project Overview & Context (專案概述與當前上下文)

**核心目標**：
本專案為「明日方舟：終末地 (Arknights: Endfield)」專用的抽卡紀錄分析與視覺化工具。透過與官方 Gryphline 服務介接，獲取玩家的尋訪紀錄，並在不持久化保存敏感個人資訊的前提下，提供深度的抽卡統計（各卡池出金率、平均抽數、保底墊抽數等）。

**技術棧 (Tech Stack)**：
*   **後端**：Node.js + Firebase Cloud Functions + Express。
*   **前端**：EJS 樣板引擎 + Vanilla JS/CSS（零前端框架，追求極致輕量化與快速渲染）。
*   **儲存**：Firebase Realtime Database / Firestore（僅用於快取與匿名化統計，**絕對不存**明文 Token）。
*   **輔助工具**：Chromium 擴充功能 (`Endfield-Overseas-Gacha-Helper-Extension`)，負責從官方網頁中安全提取 `X-Role-Token` 與登入 Cookie。

**當前系統最新狀態**：
*   已完成全面 SEO 優化（於全域注入 Canonical URL、更新 Login 頁面 Meta 內容）。
*   已完成各卡池的「獨立統計與渲染」架構（角色池與武器池完全拆分）。
*   已對齊並修正終末地特有的星級邏輯：包含武器池在內，最高稀有度（出金）皆為 6 星。

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
1.  **無狀態架構與隱私優先**：使用者的憑證（Tokens、Cookies）僅在記憶體中短暫停留，用於向官方發起代理請求後即銷毀，實作「用完即棄」。
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
    *   終末地卡池分為：`基礎尋訪`、`特許尋訪`、`啟程尋訪`、`武庫申領`。
    *   **不要**嘗試把所有卡池的保底與抽數混在一起算。在 `index.ejs` 中，我們已經改為迴圈遍歷各卡池獨立渲染，請維持這個模式。
4.  **防爬蟲與併發限制**：
    *   向官方獲取資料的 `fetchAllLogsSlowly` 等函數中，刻意保留了 `sleep(200)` 等延遲機制，這是為了避免觸發官方 API 的 Rate Limit 或 WAF 阻擋。**請勿**為了追求速度而移除這些延遲。
5.  **與 Arknights (明日方舟) 的差異**：
    *   如果您同時維護 `Firebase-global-arknightsgacha`，請注意明日方舟的官方 API 星級可能是從 0 開始索引的（即 `5` 代表 6 星），但**終末地的 API 是真實星級**（`6` 就是 6 星）。**不要**將明日方舟的 `lastCounts['5']` 邏輯直接複製到本專案中。
