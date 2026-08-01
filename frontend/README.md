## 環境需求

- Node.js 20 以上
- npm
- Mapbox access token

## 啟動方式

1. 安裝套件

```bash
npm install
```

2. 建立環境檔

PowerShell:

```powershell
Copy-Item .env.example .env.local
```

macOS / Linux:

```bash
cp .env.example .env.local
```

將 `.env.local` 裡的 `VITE_MAPBOX_TOKEN` 換成你的 Mapbox token。

3. 啟動開發伺服器

```bash
npm run dev
```

啟動後依照 Vite 終端機顯示的網址開啟，通常是 `http://localhost:5173/`。

## 常用指令

```bash
npm run dev        # 開發模式
npm run build      # 產生正式版 build
npm run preview    # 預覽正式版 build
npm run test       # 執行測試
npm run lint       # 執行 lint
```

## 資料來源：`demo` / `api`

`.env.local` 的 `VITE_DATA_SOURCE`（`demo`｜`api`，預設 `demo`）決定前端從哪裡取得城市狀態資料：

- `demo`：完全使用 `public/data/` 底下的靜態資料集（道路網路、車流、人流、事件、SOP 規則文字），不需要後端。
- `api`：即時車流/人流數值、事件建立、AI 對話、公告發布、報告查詢改打真實後端（見 `docs/backend-docs.md`，base path 由 `VITE_API_BASE_URL` 設定，本機開發可用 `VITE_API_PROXY_TARGET` 走 Vite proxy）。

**即使切到 `api` 模式，以下資料仍會從 `public/data/` 讀取**，因為後端目前還沒有對應 API（詳見 `docs/frontend-backend-coordination-issues.md`、`docs/frontend-mock-data-inventory.md`）：

- 路網幾何、路徑座標、站點座標與名稱（沒有 reference-data API）。
- 警示時間軸的觸發來源與注入事件清單（沒有「列出目前有哪些警示/決策」的清單型 API，前端 rule engine `src/engine/*` 仍是唯一資料來源）。

這兩塊會在後端補齊對應 API 後才能移除，目前不是可清除的假資料，而是暫時必要的參考設定。
