# Backend：全新環境部署

以下流程適用於尚未建立 Terraform state、Aurora、S3、CloudFront、API Gateway 或
Lambda 的 AWS 帳號／區域。會建立完整基礎設施並將 Demo 資料寫入新的 Aurora；不要用於
已有舊版 schema 的資料庫。

## 前置條件

- Terraform 1.10 以上
- AWS CLI 已登入目標帳號，且設定欲部署區域
- Docker Desktop 已啟動（API Lambda 使用 container image）
- Python 3.12 與 `pip`（建置 database seed Lambda）

確認登入帳號與區域：

```bash
aws sts get-caller-identity
aws configure get region
```

## 1. 建立 Terraform state bucket

```text
backend/
├── service/
│   ├── city_state/, incident/, decision/, chat/, publication/,
│   │   report/, decision-generator-worker/   # per-endpoint Lambda containers
│   ├── db.py                         # Aurora PostgreSQL access (operational source-of-truth data)
│   ├── s3_cache.py                   # S3-backed decision cache (see below)
│   ├── rules/                        # SOP 規則引擎（確定性計算，非 LLM，判斷備援）
│   └── agent/                        # 判斷層（decision_agent.py/facts.py）+ 敘事層（narrator.py）
└── terraform/
    ├── bootstrap/                    # 建立 Terraform remote state bucket
    ├── database/schema.sql           # PostgreSQL schema
    ├── scripts/
    │   ├── build_seed_lambda.sh      # 建置資料載入 Lambda package
    │   ├── load_demo_data.py          # CSV/JSON → PostgreSQL upsert
    │   └── seed_handler.py            # database-seed Lambda entry point
    ├── backend.tf                    # S3 backend 宣告
    └── *.tf                           # AWS infrastructure resources（api/automation/compute/storage）
```

## Terraform remote state

Terraform state 與 lock file 存在獨立的 S3 bucket，不能由主 Terraform
同時建立，否則會出現「尚未有 state bucket，卻需要 state 才能建立 bucket」的循環依賴。

主 Terraform 需先有 remote state bucket，因此先部署 bootstrap：

```bash
cd backend/terraform/bootstrap
terraform init
terraform apply
terraform output -raw terraform_state_bucket
```

將輸出的 bucket 名稱填入 [`terraform/dev.tfbackend`](terraform/dev.tfbackend) 的
`bucket` 欄位。

## 2. 設定部署變數

回到 Terraform 目錄，確認 [`terraform/terraform.tfvars`](terraform/terraform.tfvars)。所有
環境設定都集中在此檔案：`aws_region`、`project_name`、Aurora Serverless 容量、選填的 Bedrock 設定、
兩個結果 bucket 名稱與 CORS origin。

S3 bucket 名稱為全 AWS 共用；若預填名稱已被占用，請直接修改
`internal_results_bucket_name` 與 `public_results_bucket_name` 為不同且唯一的名稱。

因此 state 與 lock 位置是：

```text
s3://<state-bucket>/ai-city-commander/dev/terraform.tfstate
s3://<state-bucket>/ai-city-commander/dev/terraform.tfstate.tflock
```

`use_lockfile` 需要 Terraform 1.10 或更新版本；不要使用已淘汰的 DynamoDB state lock。

## 資料庫載入流程

主 Terraform 的 `database.tf` 建立一個私有 `database-seed` Lambda。
它不經 API Gateway 對外公開，僅由 Terraform 的 `aws_lambda_invocation` 呼叫。

```text
terraform apply
  → 建立 Aurora PostgreSQL Serverless v2、Data API 與 Secrets Manager secret
  → 建立 database-seed Lambda（私有子網）
  → Terraform 呼叫 Lambda 一次
  → Lambda 讀取 Secret 取得 Aurora 連線資訊
  → 執行 database/schema.sql
  → 執行 load_demo_data.py
  → 將 CSV / JSON Demo 資料 upsert 至 Aurora
```

載入資料包含道路、站點、道路拓撲、車流快照、人流快照與事故——**不含** SOP
條文：那份現在完全活在程式碼裡（`agent/sop_sections.py` 的 `FULL_SOP_TEXT`/
`SOP_SECTIONS`），RDS 沒有對應的表，`decide()` 呼叫 LLM 時直接把這份文字組進
prompt，不用查資料庫。匯入程式使用主鍵 upsert，因此重跑會更新既有資料，而
不會重複新增同一筆 snapshot 或事件。

## 本機 DB 測試

不需要真的連 RDS，本機起一個 Postgres 容器就能測 `db.py` 跟所有 DB 相關的
handler routes：

```bash
docker run -d --name aicity-pg -e POSTGRES_PASSWORD=aicity -e POSTGRES_DB=aicity \
  -p 5432:5432 postgres:16

DATABASE_URL='postgresql://postgres:aicity@localhost:5432/aicity' \
  python3 backend/terraform/scripts/load_demo_data.py

cd backend/service
pip install -r requirements-dev.txt
DATABASE_URL='postgresql://postgres:aicity@localhost:5432/aicity' pytest tests/ -v
```

`tests/test_db.py`／`tests/test_handler_db_routes.py` 會在沒偵測到可連線的
Postgres 時自動 skip（不會讓其他不需要 DB 的測試跟著失敗）。`test_db.py`
每個測試都在同一個未 commit 的 transaction 裡跑、結束時 rollback，所以不會
弄髒共用的 demo 資料。

## 決策快取（S3，2026-08-01 起）

**決策內容（`triggered`/`result`/`reasoning`/`publicMessage`）只存在 S3，
不進 RDS。** RDS 只是操作型的原始資料（路段、站點、快照、事故）；判斷結果
是快取，快取活該在物件儲存，不該佔用關聯式資料庫——這是這次改動的方向。

`s3_cache.py` 是唯一的快取存取層，key 格式對照 `data/api.md` 的
`decisions/{scenarioAt}/{locationId}.json`：

```
decisions/{scenario_at}/{segment_id}.json                    congestion（§1）
decisions/{scenario_at}/{station_id}__{decision_kind}.json   mrt/dome（§3/§4）
decisions/{scenario_at}/all.json                              multilingual（§6，全站點一次批次判斷）
decisions/{scenario_at}/{event_id}__{alert_kind}.json        事故 SOP 檢查（§2/§5）
```

`scenario_at` 裡的 `:` 一律用 `-` 取代（S3 key 技術上允許冒號，但部分工具處理
不佳，跟 `data/api.md` 範例一致）。Bucket 名稱來自 `INTERNAL_RESULTS_BUCKET`
環境變數（Terraform 的 `internal_results_bucket_name`，見 `compute.tf`）。

本機測試 `s3_cache.py` 用 `moto` mock S3，不需要真的建 bucket（見
`tests/test_s3_cache.py`）；本機互動測試（`local_server.py` 手動點）則需要
一個真的、可寫入的 S3 bucket——部署過一次 Terraform 之後用那個
`internal_results_bucket_name`，或自己先 `aws s3 mb` 一個 scratch bucket，
設定 `INTERNAL_RESULTS_BUCKET` 指過去。

### 清快取（測試時很常用）

同一個 `scenario_at` 只要被判斷過一次就不會再呼叫 LLM（S3 object 已存在）——
測試時想看到重新判斷（例如換了 prompt、換了 model），要先清掉舊的快取物件。
用 `clear_cache.py`：

```bash
cd backend/service
export INTERNAL_RESULTS_BUCKET='<your-bucket-name>'
export AWS_REGION='us-west-2'   # 或你實際部署的區域

python3 clear_cache.py --scenario-at "2026-05-20T22:10:00+08:00"  # 清這個模擬時刻的全部快取物件
python3 clear_cache.py --event-id TPE_2026_ACC_001                # 清某個事件的全部快取（不分時間）
python3 clear_cache.py --all                                       # 清 decisions/ 底下所有物件
```

## 3. 建置 database seed Lambda

```bash
cd backend/terraform
./scripts/build_seed_lambda.sh
```

此步驟會打包新 schema 與 Demo CSV／JSON 資料。主部署完成時，Terraform 會呼叫此
私有 Lambda，建立 schema 並載入初始資料。

## 4. 初始化、檢查與部署

```bash
terraform init -reconfigure -backend-config=dev.tfbackend
terraform plan
terraform apply
```

部署會建立：VPC、Aurora PostgreSQL Serverless v2、Data API、Secrets Manager、S3、CloudFront、API Gateway、ECR、各 Lambda、
EventBridge 五分鐘排程與 SNS。

## 判斷 vs. 計算 vs. 敘事：三層架構

**方向（2026-07-27 定案）：SOP 判斷（觸發哪條、分級、選哪條路線）由 LLM 決定，
不是確定性程式碼——LLM 必須參與「決策」本身，不能只負責把已經算好的結果寫成
白話文。程式碼只做「不涉及判斷」的事：整理原始數據、算候選項的結構性屬性
（capacity、是否直接相交、是否上游、目前飽和度），真正的分級/觸發/選路
判斷交給 LLM 讀取這些事實 + SOP 全文後決定，決定與理由同時產出。**

```
backend/service/
├── rules/     # 純數值計算 + 【備援】判斷邏輯（無 LLM 時的安全網，不是主路徑）
└── agent/
    ├── facts.py            # 組「原始事實」給 LLM（不預先分類/不預先選路）
    ├── decision_agent.py   # 主要判斷路徑：事實 + SOP 全文 → LLM 決定 + 理由
    ├── narrator.py         # 純敘事（把已知結果轉白話文，不判斷）
    ├── templates.py        # narrator 的罐頭文字備援
    └── llm_client.py       # 可替換 LLM 介面（AgentCore／Anthropic／OmniRoute）
```

### `rules/`：計算層 + 判斷的備援層

`backend/service/rules/` 是 SOP 七條規則的確定性 Python 實作（飽和度分級、
ETE 公式、SOP 第2條疏散路徑演算法等），從 `frontend/src/engine/*.ts` 對照移植。

這層現在的角色是**沒有 LLM 可用時的備援**（沒設定憑證、呼叫失敗、或回應不是
合法 JSON 時自動接手），不是正常情況下的判斷路徑——只要 LLM 可用，判斷結果
以 LLM 的輸出為準。ETE 公式是例外：純算術、沒有模糊空間，維持由程式碼計算，
當成一個「已算好的數字」交給 LLM 引用，不算「判斷走哪條 SOP」。

本機測試（不需要 AWS/資料庫，直接對照 `data/` 原始資料集跑）：

```bash
cd backend/service
pip install -r requirements-dev.txt
pytest tests/ -v
```

`tests/test_rules.py` 是從 `frontend/src/engine/ruleEngine.test.ts` 逐項移植
的相同案例（同樣的數字、同樣的期望值），另外加了兩類補充測試：

- 對照 `data/road_network_geometry.json` 實際資料跑一次驗證案例 A（RD_TPE_002 封閉）。
- 「正氣橋」型別的未對應路口名稱（見 `data/unmatched_intersection_names.json`）：
  前端參考實作在建圖時會把找不到對應 `segment_id` 的路口名稱直接濾掉，
  這會讓 `intersectionIds` 陣列比 `intersections` 短，導致後面所有索引往前
  偏移，在特定情況下可能誤判路口在事故點的上/下游。這裡的 Python 版本改成
  保留陣列等長、未對應處填 `None`（與 `schema.sql` 的
  `road_segment_intersection_refs.intersecting_segment_id` 可為 `NULL` 設計一致），
  避免這個位移問題。

### `agent/facts.py` + `agent/decision_agent.py`：真正的判斷層（LLM 為主）

`decision_agent.py::decide()` 是通用的「事實進、決定出」呼叫：把原始事實
（JSON）+ SOP 七條全文一起丟給 LLM，要求它輸出結構化 JSON
（`triggered`、`sop_section_id`、`result`、`reasoning`、`public_message`），並指示它「不要重新
計算數字、只能引用 SOP 原文條款」。`agent/facts.py` 針對六種情境（飽和度分級、
事故疏散、捷運分流、大巨蛋散場、號誌故障、多語通報）各寫一個 `decide_*()`，
每個都只組「原始事實」——例如事故情境給的是候選替代路段清單（capacity_vph、
是否直接相交、是否上游、目前飽和度），**不會**先幫忙選出哪條是主路；那個
選擇本身就是要 LLM 決定的事。

`reasoning` 跟 `public_message` 是同一次呼叫產出的兩個受眾版本：`reasoning`
給交通控制中心指揮官看，引用 SOP 條號、門檻數字與內部處置細節；
`public_message` 給一般民眾看，只講對民眾有用的行動建議（改道、預留時間等），
不能出現 SOP 條號、門檻數字或警力/號誌等內部調度資訊（對照 `data/api.md`
第638行 chat 端點的政府/民眾模式區隔，以及 public/internal 兩個 S3 bucket
的權限設計）。前端 `utils/publicView.ts::getPublicAlertText()` 只能讀
`publicMessage`，不可以讀 `reasoning`/`llmText`。未觸發時 `public_message`
應為空字串。

沒有 LLM、呼叫失敗、或回應解析失敗時，退回 `rules/` 對應的確定性函式（結果
會標記 `"source": "fallback"` 以便區分）。這是安全網，不是設計上的正常路徑。

### `agent/narrator.py`：純敘事層（不判斷）

`summarize()` / `answer_what_if()` 拿**已經知道的結果**轉成白話文（例如
`decide_*()` 判斷完之後的結果，或 `rules/` 備援算出的結果），本身不做任何
判斷。`generate_multilingual()` 完全不用 LLM，純模板——固定格式的 CMS/簡訊
文字用決定性字串組合比 LLM 翻譯可靠。

`llm_client.py` 是可替換的 LLM 介面，`decide()` 跟 `narrator.py` 共用：

- 有設定 `BEDROCK_AGENTCORE_RUNTIME_ARN` → 走 AgentCore（尚未實作，等 Runtime 部署好）。
- 有設定 `BEDROCK_MODEL_ID` → 直接呼叫 Bedrock（`BedrockLLMClient`，走 `boto3` 的
  `converse()` API）。**這是 2026-08-01 起的正式部署路徑**，用 IAM Role 認證，
  不是 API key/access key——不讀取、不儲存任何憑證，`boto3` 會自動走標準 AWS
  憑證鏈：部署到 Lambda 後自動用該函式的 execution role（暫時性、AWS 自動輪替，
  見 `terraform/compute.tf` 的 `bedrock:InvokeModel` 權限），本機開發則用
  `aws configure`/`AWS_PROFILE` 解析出的憑證。第一次呼叫前，AWS 帳號要先在
  Bedrock console 的 Model catalog 對 Anthropic 模型送出一次性的 use case 表單
  （每帳號一次，送出後立即生效）。本機測試需要 `AWS_REGION`（例如
  `ap-northeast-1`）；部署到 Lambda 後不用設，Lambda 會自動注入該函式的部署區域
  （`AWS_REGION` 是 Lambda 保留變數，Terraform 不能自己設）。
- 有設定 `ANTHROPIC_API_KEY` → 直接呼叫 Anthropic API（保留給還留著這組 key 的人，
  非建議路徑）。
- 有設定 `OMNIROUTE_BASE_URL` → 走本機 OmniRoute 多供應商路由器（純開發測試用，
  該共用池目前不太穩定，常見 40~60% 失敗率，但失敗一律安全退回備援，不會讓
  API 出錯；**逐步淘汰中**，改用 Bedrock）。
- 都沒有 → 全部退回 `rules/`（判斷）或 `templates.py`（敘事）的確定性結果，
  API 不會因為沒憑證而壞掉。

優先順序：AgentCore（若真的部署了 Runtime）> Bedrock（IAM Role）> Anthropic
直接 key > OmniRoute。

`/api/agent` 的請求格式（`{"action": ..., ...}`）：

| action | 欄位 | 回應 |
| --- | --- | --- |
| `decide` | `scope`（`congestion`/`accident`/`mrt_diversion`/`dome_dispersal`/`signal_failure`/`multilingual`）+ 各情境對應欄位，見 `handler.py::_handle_decide` | `{"triggered", "sopSectionId", "result", "reasoning", "publicMessage", "source"}` |
| `summarize` | `kind`, `title`, `data`, `sopRef?` | `{"text": "..."}` |
| `answer_what_if` | `question`, `ruleResult?`, `sopExcerpt?` | `{"text": "..."}` |
| `generate_multilingual` | `messageType`, `values` | `{"messages": {"zh":..., "en":..., "ja":..., "ko":...}}` |

### 還沒做的

- What-if 聊天的自由文字意圖理解：`retrieve_relevant_sections()`（`sop_sections.py`）
  目前還是關鍵字比對，沒有改用 LLM/`decide()` 理解問題在問什麼。
- 多條 SOP 同時觸發時的整合/優先序判斷（例如同一事件同時符合第1條跟第2條）。
- 邏輯還沒搬進 `city_state/`／`incident/`／`decision/`／`chat/`／`publication/`／
  `report/`／`decision-generator-worker/` 這 7 個 per-service Lambda——目前
  `backend/service/handler.py` 是唯一實際跑判斷邏輯的地方，那 7 個容器化
  Lambda 現在還是寫死的 demo JSON，之後要把 `handler.py` 的邏輯拆過去。

完成後可取得入口資訊：

```bash
terraform output frontend_url
terraform output api_gateway_url
terraform output public_results_url
```

## 5. 部署後確認

```bash
aws lambda list-functions --query 'Functions[?starts_with(FunctionName, `ai-city-commander`)].FunctionName'
aws s3 ls s3://<internal-results-bucket>/
aws s3 ls s3://<public-results-bucket>/public/
```

公開公告由 CloudFront 的 `/public/*` 讀取；內部事件、決策與政府報告僅允許 Lambda 透過
IAM 存取。
