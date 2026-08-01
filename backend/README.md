# Backend infrastructure

本目錄包含 AI City Commander 的 AWS 後端服務與 Terraform 基礎設施。

```text
User
  → CloudFront
    ├─ S3：Frontend
    └─ API Gateway → Lambda API → RDS PostgreSQL
                                  → Bedrock AgentCore Runtime（選用）

Terraform apply
  → database-seed Lambda → RDS PostgreSQL
```

## 目錄

```text
backend/
├── service/
│   ├── handler.py                    # API Gateway Lambda handler
│   ├── rules/                        # SOP 規則引擎（確定性計算，非 LLM）
│   └── agent/                        # 文字生成層（有 LLM 憑證才真的呼叫，否則回罐頭文字）
└── terraform/
    ├── bootstrap/                    # 建立 Terraform remote state bucket
    ├── database/schema.sql           # PostgreSQL schema
    ├── scripts/
    │   ├── build_seed_lambda.sh      # 建置資料載入 Lambda package
    │   ├── load_demo_data.py          # CSV/JSON → PostgreSQL upsert
    │   └── seed_handler.py            # database-seed Lambda entry point
    ├── backend.tf                    # S3 backend 宣告
    └── *.tf                           # AWS infrastructure resources
```

## Terraform remote state

Terraform state 與 lock file 存在獨立的 S3 bucket，不能由主 Terraform
同時建立，否則會出現「尚未有 state bucket，卻需要 state 才能建立 bucket」的循環依賴。

先執行 bootstrap：

```bash
cd backend/terraform/bootstrap
terraform init
terraform apply
terraform output -raw terraform_state_bucket
```

Bootstrap 建立的 bucket 具備：

- S3 versioning
- AES256 預設加密
- Block Public Access
- `prevent_destroy = true`

將輸出的 bucket 名稱填入版本控制中的 `backend/terraform/dev.tfbackend`；主 Terraform 使用：

```hcl
encrypt      = true
use_lockfile = true
```

因此 state 與 lock 位置是：

```text
s3://<state-bucket>/ai-city-commander/dev/terraform.tfstate
s3://<state-bucket>/ai-city-commander/dev/terraform.tfstate.tflock
```

`use_lockfile` 需要 Terraform 1.10 或更新版本；不要使用已淘汰的 DynamoDB state lock。

## 資料庫載入流程

主 Terraform 的 `database_seed.tf` 建立一個私有 `database-seed` Lambda。
它不經 API Gateway 對外公開，僅由 Terraform 的 `aws_lambda_invocation` 呼叫。

```text
terraform apply
  → 建立 RDS 與 Secrets Manager secret
  → 建立 database-seed Lambda（私有子網）
  → Terraform 呼叫 Lambda 一次
  → Lambda 讀取 Secret 取得 RDS 連線資訊
  → 執行 database/schema.sql
  → 執行 load_demo_data.py
  → 將 CSV / JSON Demo 資料 upsert 至 RDS
```

載入資料包含道路、站點、道路拓撲、車流快照、人流快照、事故與 SOP 文件。
匯入程式使用主鍵 upsert，因此重跑會更新既有資料，而不會重複新增同一筆 snapshot 或事件。

**已知缺口**：`load_demo_data.py` 目前不會載入 `sop_documents`/`sop_sections`
（`data/emergency_traffic_sop.txt`），但 `response_alerts.sop_section_id` 有
FK 指向 `sop_sections`，所以要寫入 `response_alerts` 前必須先手動塞資料，
否則會撞 `ForeignKeyViolation`。本機測試已經用 `agent/sop_sections.py` 裡
現成的七條結構化資料補了這塊（見下方「本機 DB 測試」），但 seed script 本身
還沒補上，需要另外修。

## 本機 DB 測試

不需要真的連 RDS，本機起一個 Postgres 容器就能測 `db.py` 跟所有 DB 相關的
handler routes：

```bash
docker run -d --name aicity-pg -e POSTGRES_PASSWORD=aicity -e POSTGRES_DB=aicity \
  -p 5432:5432 postgres:16

DATABASE_URL='postgresql://postgres:aicity@localhost:5432/aicity' \
  python3 backend/terraform/scripts/load_demo_data.py

# 補上面提到的 sop_sections 缺口（load_demo_data.py 還沒做這步）：
cd backend/service
DATABASE_URL='postgresql://postgres:aicity@localhost:5432/aicity' python3 -c "
import db
from agent.sop_sections import SOP_SECTIONS
conn = db.connect()
conn.execute(\"INSERT INTO sop_documents (document_name, version, body) VALUES (%s,%s,%s)\",
             ('emergency_traffic_sop','1','see data/emergency_traffic_sop.txt'))
doc_id = conn.execute('SELECT sop_document_id FROM sop_documents ORDER BY sop_document_id DESC LIMIT 1').fetchone()[0]
for s in SOP_SECTIONS:
    conn.execute('INSERT INTO sop_sections (sop_section_id, sop_document_id, title, body, keywords, display_order) VALUES (%s,%s,%s,%s,%s,%s)',
                 (s.id, doc_id, s.title, s.text, list(s.keywords), int(s.id)))
conn.commit()
"

pip install -r requirements-dev.txt
DATABASE_URL='postgresql://postgres:aicity@localhost:5432/aicity' pytest tests/ -v
```

`tests/test_db.py`／`tests/test_handler_db_routes.py` 會在沒偵測到可連線的
Postgres 時自動 skip（不會讓其他不需要 DB 的測試跟著失敗）。`test_db.py`
每個測試都在同一個未 commit 的 transaction 裡跑、結束時 rollback，所以不會
弄髒共用的 demo 資料；`test_handler_db_routes.py` 測的是真正經過兩次獨立
handler 呼叫才能驗證的行為（例如快取），沒辦法用同一個 transaction 包住，
改用 `TEST_` 前綴 + 每個測試前後清除來隔離。

`response_alerts.scenario_at`（2026-07-31 新增欄位）：仿照
`traffic_snapshots`/`crowd_snapshots` 既有的 `observed_at`（模擬時間）
vs. `ingested_at`（真實寫入時間）分離設計，讓「同一個事件在同一個模擬時間
有沒有評估過」可以直接查 `(event_id, scenario_at, alert_kind)` 唯一索引，不用
每次都重新呼叫 LLM——這是本次新增，`schema.sql` 已更新，如果 RDS 上已經跑過
舊版 schema，需要重新 apply。

### 清快取（測試時很常用）

`response_alerts`／`congestion_decisions`／`crowd_decisions` 都是快取，同一個
`scenario_at` 只要被判斷過一次就不會再呼叫 LLM——測試時想看到重新判斷（例如
換了 prompt、換了 model），要先清掉舊的快取。用 `clear_cache.py`：

```bash
cd backend/service
export DATABASE_URL='postgresql://postgres:aicity@localhost:5432/aicity'

python3 clear_cache.py --scenario-at "2026-05-20T22:10:00+08:00"  # 清這個模擬時刻的全部快取（三張表）
python3 clear_cache.py --event-id TPE_2026_ACC_001                # 清某個事件的全部快取（不分時間）
python3 clear_cache.py --all                                       # 全部清空
```

## 部署

先確認 Terraform 為 1.10+，再建置 database-seed Lambda 的 Linux 相容套件：

```bash
cd backend/terraform
./scripts/build_seed_lambda.sh
```

接著初始化 remote backend 並部署：

```bash
terraform init -reconfigure -backend-config=dev.tfbackend
terraform plan
terraform apply
```

`build_seed_lambda.sh` 會將 Linux x86_64 / Python 3.12 相容的 `psycopg`、schema、Demo CSV/JSON 與載入程式打包。這是必要步驟，因為 Lambda 在 Linux 環境執行，而本機可能是 macOS。

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
  見 `terraform/iam.tf` 的 `bedrock:InvokeModel` 權限），本機開發則用
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
- DB／RDS 串接：`handler.py` 現在資料是吃 request payload，沒有查資料庫。

## 本機設定檔

以下檔案不應提交：

```text
backend/terraform/.terraform/
backend/terraform/.build/
*.tfstate
```

開發環境的 `terraform.tfvars` 與 `dev.tfbackend` 為版本控制檔，固定使用 `us-east-2`。
