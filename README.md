# AI City Commander

AI City Commander 是一套面向大型城市活動與交通事件的智慧營運指揮平台。系統以台北市交通與人流場景為示範，整合即時道路壅塞、捷運站點人流、突發事故、SOP 規則引擎與 AI 決策代理，協助指揮中心在事件發生後快速產生分流建議、跨單位協調資訊、公開告警內容與事後報告。

本專案包含 React 前端指揮台、Python Serverless 後端、AWS 基礎設施定義、SOP/LLM 決策模組，以及公開告警佈署與大量用戶輪詢實驗。

## 特色亮點

- **政府端／民眾端雙模式介面**：同一份地圖與事件資料，依身份切換呈現內容。政府端可見完整 SOP 推理鏈、內部決策依據與跨機關協調建議；民眾端僅呈現摘要化的公開訊息與問答，兩種身份各自維護獨立的對話紀錄，避免內部決策細節誤發給一般民眾。
- **「現場定位小人」地圖互動**：可將地圖左下角的人形圖示拖曳並放置到地圖上的任意位置，系統會即時回報該座標的鄰近路段，並自動附掛為 AI 聊天室的「目前位置」情境標籤。放置後再向小助手提問（例如「我這裡現在狀況如何」），回覆就會直接關聯到最近路段的即時路況與相關 SOP 決策建議，而不需要手動輸入地點。
- **規則優先、AI 增強的可解釋決策**：SOP 判斷以可測試、可回退的 deterministic 規則為底層保障，LLM 只負責整理推理敘事、生成公開訊息與情境問答；LLM provider 未設定或呼叫失敗時，系統仍可用規則與模板輸出維持基本運作，不會整條決策鏈中斷。
- **可擴展的公開告警發布路徑**：民眾端大量讀取告警內容改由 CloudFront 直接讀取 S3 manifest/notice，不經過 API Gateway 與 Lambda。`experiments/incident-manifest-polling/` 的壓測結果顯示，在 1,000 與 10,000 client 規模下，此路徑的延遲與穩定度都明顯優於走 Lambda proxy 的方案。
- **事故到報告的完整流程**：從事故建立、SOP 規則觸發、AI 決策生成，到多語公開訊息與事後報告匯出，全程資料保留可追溯的 `triggered`、`sopSectionId`、`reasoning`、`publicMessage` 等欄位。

## 專案目標

- 即時呈現道路、場站與事故狀態，支援政府端與民眾端兩種視角。
- 根據 SOP 規則判斷交通壅塞、事故封閉、捷運分流、場館疏散、號誌故障與多語告警需求。
- 結合 LLM 產生可解釋的決策理由、行動建議、公開訊息與情境問答。
- 將內部決策與公開資訊分流保存，降低敏感資訊外洩風險。
- 以 AWS Serverless 架構支援 API、事件處理、報告產生、公開告警與靜態網站部署。

## 核心功能

### 1. 城市營運儀表板

前端以 React、Vite、Mapbox、deck.gl 與 Zustand 建置。主要畫面包含：

- 地圖舞台：顯示道路壅塞、替代路線、事故位置與場站熱點。
- 時間軸：播放示範資料中的城市狀態變化。
- 左側資訊面板：道路與站點清單、狀態指標與圖例。
- 右側決策面板：事件摘要、SOP 推理鏈、決策建議、公開訊息預覽與匯出功能。
- 底部事件列：事故與告警時間序列。
- AI 聊天助理：支援政府端 what-if 問答與民眾端公開資訊問答。

### 2. SOP 規則與 AI 決策

系統目前涵蓋下列 SOP 類型：

- SOP 1：道路壅塞等級與城市應變。
- SOP 2：事故封閉與替代疏散路線。
- SOP 3：捷運站點人流分流。
- SOP 4：大型場館散場與人群疏散。
- SOP 5：號誌或供電異常應變。
- SOP 6：多語系告警需求判斷。
- SOP 7：預估排除時間 ETE。

後端 `backend/service/rules/` 提供可測試、可回退的 deterministic 規則；`backend/service/agent/` 則負責整理 facts、呼叫 LLM、產生 reasoning、public message 與 narrative summary。當 LLM 未設定或呼叫失敗時，系統仍可回退至規則與模板輸出。

### 3. API 與事件流程

後端 API 路由定義於 Terraform 與本機 server，主要包含：

| Method | Path | 用途 |
| --- | --- | --- |
| `GET` | `/api/city-state` | 查詢指定 `scenarioAt` 的交通與人流狀態 |
| `POST` | `/api/incidents` | 建立或注入事故事件 |
| `GET` | `/api/incidents/{eventId}/report` | 查詢事故報告產生狀態，JSON 格式完整內容內嵌回傳 |
| `GET` | `/api/decisions` | 查詢指定時間與位置的決策結果 |
| `POST` | `/api/chat/messages` | 送出政府端或民眾端問答 |
| `POST` | `/api/publication` | 發布告警訊息 |
| `GET` | `/api/experiments/public-notices` | 實驗用公開 notice/manifest 查詢 |

### 4. 公開告警與報告

系統將內部決策快取、事故報告與公開告警分開保存：

- Internal S3 bucket：事故資料、決策快取、政府端報告（JSON/PDF，由 `backend/service/report_builder.py` 產生並歸檔）。
- Public S3 bucket + CloudFront：公開 notice 與 manifest。
- Report API：JSON 報告以完整內容內嵌回傳；前端「匯出」按鈕則直接以現有事件/決策資料在瀏覽器端即時產生 PDF／JSON，確保匯出功能不受後端報告產生時間影響。
- Publication API：產生多語訊息、發布狀態與 channel status。

### 5. 大量用戶輪詢實驗

`experiments/incident-manifest-polling/` 比較兩種公開告警讀取方式：

- CloudFront 直接讀取 public results manifest/notice。
- API Gateway + Lambda proxy 讀取 notice。

實驗報告顯示，在 1,000 與 10,000 client 規模下，CloudFront 在延遲與穩定度上明顯優於 Lambda proxy，適合作為大量民眾端公開告警的主要讀取路徑。

## 系統架構

### AWS 雲端運行架構

![AWS 架構圖](frontend/public/architecture.png)

系統只使用單一 CloudFront distribution，依路徑分流到三個不同 origin：

- 預設路徑（`/*`）→ frontend S3 bucket：提供 React SPA 靜態資源。
- `/api/*` → API Gateway (HTTP API) → 對應的 Lambda（`city_state`、`incident`、`decision`、`report`、`chat`、`publication`）。
- `/public/*` → public results S3 bucket：民眾端輪詢公開 manifest/notice 直接由 CloudFront + S3 回應，不經過 Lambda，對應上方「特色亮點」中的大量輪詢壓測結論。

`incident` 與 `decision` 在快取未命中時，會非同步觸發 `decision-generator-worker`，整合 Aurora Serverless（城市/事故資料）與 Amazon Bedrock（LLM 推理與敘事生成），將結果寫回 Aurora 與 internal / public results 兩個 S3 bucket，落實政府端與民眾端資料分流保存。`publication` Lambda 另外掛載一個 SNS topic，作為未來串接簡訊、推播等多通路示警的擴充點；目前競賽版本以模擬 `published` 狀態回傳各發布通路結果。

### 專案目錄結構

```text
.
├── frontend/                       # React + Vite 前端指揮台
│   ├── public/data/                # Demo CSV/JSON 資料
│   ├── src/components/             # 地圖、面板、圖表、聊天與共用 UI
│   ├── src/engine/                 # 前端 demo 模式使用的 SOP 規則
│   ├── src/services/               # API adapter、聊天、LLM adapter、公開 notice
│   └── src/store/appStore.ts       # 全域狀態、時間軸與事件流程
├── backend/
│   ├── service/                    # Python Lambda handlers 與本機 server
│   │   ├── agent/                  # LLM client、facts、decision agent、narrator
│   │   ├── rules/                  # SOP 規則與 fallback 邏輯
│   │   ├── tests/                  # 後端單元測試
│   │   └── local_server.py         # 本機 API server
│   └── terraform/                  # AWS infra: API Gateway、Lambda、Aurora、S3、CloudFront
├── docs/                           # 範例事故與 API 規格文件
└── experiments/                    # 公開告警輪詢壓測與比較報告
```

## 環境需求

### 前端

- Node.js 20 以上
- npm
- Mapbox access token

### 後端本機開發

- Python 3.12
- pip
- PostgreSQL 16（只有需要測試 DB 流程時才必須）
- AWS CLI（需要連接 AWS 或測試 Bedrock/S3 時）

### AWS 部署

- Terraform 1.10 以上
- Docker Desktop
- AWS CLI 與可部署目標帳號的憑證
- 可用的 AWS region
- 如需 LLM：Amazon Bedrock model access 或其他支援的 provider 設定

## 快速開始

### 1. 安裝前端依賴

```bash
cd frontend
npm install
```

### 2. 設定前端環境變數

PowerShell：

```powershell
Copy-Item .env.example .env.local
```

macOS / Linux：

```bash
cp .env.example .env.local
```

請至少設定：

```env
VITE_MAPBOX_TOKEN=your_mapbox_token_here
VITE_DATA_SOURCE=api
VITE_API_BASE_URL=https://your-api.example.com/api
```

若只想使用靜態 demo 資料，可將資料來源改為：

```env
VITE_DATA_SOURCE=demo
```

### 3. 啟動前端

```bash
npm run dev
```

Vite 預設會啟動於：

```text
http://localhost:5173/
```

## 本機後端開發

### 1. 安裝 Python 依賴

```bash
cd backend/service
pip install -r requirements-dev.txt
```

### 2. 啟動本機 API server

```bash
python local_server.py 8787
```

接著在 `frontend/.env.local` 設定：

```env
VITE_DATA_SOURCE=api
VITE_API_BASE_URL=http://localhost:8787/api
```

### 3. 可選：設定 LLM provider

後端會依序使用下列環境變數選擇 LLM provider：

```env
BEDROCK_AGENTCORE_RUNTIME_ARN=
BEDROCK_MODEL_ID=
AWS_REGION=
ANTHROPIC_API_KEY=
OMNIROUTE_BASE_URL=
OMNIROUTE_MODEL=
```

若未設定任何 provider，系統會使用規則與模板 fallback，不影響基本流程測試。

## 測試與品質檢查

### 前端

```bash
cd frontend
npm run lint
npm run test
npm run build
```

### 後端

```bash
cd backend/service
pytest tests/ -v
```

若要測試資料庫相關流程，可先啟動 PostgreSQL：

```bash
docker run -d --name aicity-pg \
  -e POSTGRES_PASSWORD=aicity \
  -e POSTGRES_DB=aicity \
  -p 5432:5432 \
  postgres:16
```

再設定：

```bash
DATABASE_URL=postgresql://postgres:aicity@localhost:5432/aicity
```

## AWS 部署概要

### 1. 建立 Terraform remote state bucket

```bash
cd backend/terraform/bootstrap
terraform init
terraform apply
terraform output -raw terraform_state_bucket
```

將輸出的 bucket name 填入 `backend/terraform/dev.tfbackend`。

### 2. 設定 Terraform 變數

請檢查並調整：

```text
backend/terraform/terraform.tfvars
```

常見設定包含：

- AWS region
- project name
- CORS origins
- Aurora Serverless 參數
- S3 bucket name
- Bedrock model 或 AgentCore runtime 設定

### 3. 建置 seed Lambda

```bash
cd backend/terraform
./scripts/build_seed_lambda.sh
```

### 4. 部署基礎設施

```bash
terraform init -reconfigure -backend-config=dev.tfbackend
terraform plan
terraform apply
```

部署後可取得：

```bash
terraform output frontend_url
terraform output api_gateway_url
terraform output public_results_url
```

### 5. 部署前端

從 repository root 執行：

```bash
./frontend/scripts/deploy.sh
```

此腳本會建置前端、上傳至 S3 frontend bucket，並對 CloudFront 建立 invalidation。

## Demo 資料

靜態 demo 資料位於：

```text
frontend/public/data/
├── city_traffic_flow.csv
├── signaling_crowd_density.csv
├── live_incidents.json
├── road_network_geometry.json
├── road_paths.json
└── station_coords.json
```

範例事故位於：

```text
docs/sample_incident_*.json
```

API 模式會改由後端讀取 Aurora PostgreSQL、S3 decision cache 與 public notice manifest。

## 重要設計原則

- 政府端與民眾端資訊分層：內部 reasoning、SOP references、跨機關協調與公開訊息分開處理。
- 規則優先、AI 增強：SOP 判斷以 deterministic 規則保底，LLM 負責敘事、推理整理與自然語言輸出。
- 可追溯決策：決策結果包含 `triggered`、`sopSectionId`、`result`、`reasoning`、`publicMessage` 與 `source`。
- 可擴展發布：大量公開告警讀取以 CloudFront + S3 manifest 為主，避免所有民眾端流量打到 Lambda。
- 本機與雲端路由一致：`backend/service/local_server.py` 的路由表對齊 `backend/terraform/api.tf`。

## 常用指令

```bash
# Frontend
cd frontend
npm run dev
npm run test
npm run lint
npm run build
npm run preview

# Backend
cd backend/service
python local_server.py 8787
pytest tests/ -v

# Terraform
cd backend/terraform
terraform plan
terraform apply
terraform output
```

## 專案狀態

目前專案已具備完整的前端操作介面、後端 API handler、SOP 規則測試、LLM provider fallback、AWS Terraform 部署腳本，以及公開告警輪詢壓力測試與比較報告，可完整支援本機開發與 AWS 雲端部署兩種模式。

### 後續規劃

- Publication API 的多通路（簡訊、推播等）發布串接：SNS topic 與相關 IAM 權限已於 Terraform 建置完成，正式串接為後續規劃項目。
- `/api/decisions` 目前以城市巡查（city-sweep）觸發的決策快取為主，事故觸發的個別決策以 incident/report 流程呈現；兩者的整合查詢介面為後續優化方向。
