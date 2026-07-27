## 專案結構

```text
.
└─ frontend/             # React + Vite 前端
   ├─ public/data/       # Demo 資料集
   └─ src/               # UI、狀態管理、規則引擎
```

## 環境需求

- Node.js 20 以上
- npm
- Mapbox access token

## 啟動方式

1. 進入前端目錄

```bash
cd frontend
```

2. 安裝套件

```bash
npm install
```

3. 建立環境變數

PowerShell:

```powershell
Copy-Item .env.example .env.local
```

macOS / Linux:

```bash
cp .env.example .env.local
```

將 `.env.local` 裡的 `VITE_MAPBOX_TOKEN` 換成你的 Mapbox token。

4. 啟動開發伺服器

```bash
npm run dev
```

預設會啟動在 Vite 顯示的本機網址，通常是 `http://localhost:5173/`。

## 常用指令

```bash
npm run dev        # 開發模式
npm run build      # 產生正式版 build
npm run preview    # 預覽正式版 build
npm run test       # 執行測試
npm run lint       # 執行 lint
```

## 備註

- 若地圖區塊顯示需要 Mapbox token，請確認 `frontend/.env.local` 已設定 `VITE_MAPBOX_TOKEN`。
- Demo 資料位於 `frontend/public/data/`，包含道路網路、車流、人流、事件與 SOP 規則文字。
