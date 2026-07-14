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

## Demo 資料

Demo 資料位於 `public/data/`，包含道路網路、車流、人流、事件與 SOP 規則文字。
