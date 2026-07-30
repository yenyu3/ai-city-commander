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

## SOP 規則引擎

`backend/service/rules/` 是 SOP 七條規則的確定性 Python 實作（飽和度分級、
ETE 公式、SOP 第2條疏散路徑演算法等），從 `frontend/src/engine/*.ts` 對照
移植，數值/門檻判斷全部是純程式碼、不經過 LLM——Agent 只負責在這些計算結果
之上做 SOP 選擇與文字生成。

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

## Agent 文字生成層（`backend/service/agent/`）

負責把 `rules/` 算好的結構化結果轉成自然語言（建議書敘述、What-if 回答、多語簡訊）。
`llm_client.py` 是可替換的 LLM 介面：

- 有設定 `BEDROCK_AGENTCORE_RUNTIME_ARN` → 走 AgentCore（尚未實作，等 Runtime 部署好）。
- 有設定 `ANTHROPIC_API_KEY` → 直接呼叫 Anthropic API（本機開發用）。
- 兩者都沒有 → 全部退回 `templates.py` 的罐頭文字（從 `frontend/src/services/llmAdapter.ts`
  移植過來的同一套繁中/英/日/韓模板），API 不會因為沒憑證而壞掉。

目前環境還沒有任何一組憑證，所以 `POST /api/agent` 現在跑起來就是純模板輸出。
等憑證到位後，只要設定對應環境變數即可自動切換到真實 LLM，不用改程式碼。

`/api/agent` 的請求格式（`{"action": ..., ...}`）：

| action | 欄位 | 回應 |
| --- | --- | --- |
| `summarize` | `kind`, `title`, `data`, `sopRef?` | `{"text": "..."}` |
| `answer_what_if` | `question`, `ruleResult?`, `sopExcerpt?` | `{"text": "..."}` |
| `generate_multilingual` | `messageType`, `values` | `{"messages": {"zh":..., "en":..., "ja":..., "ko":...}}` |

`retrieve_relevant_sections()`（`sop_sections.py`）目前只是關鍵字比對，是 What-if
聊天用的暫時性候選檢索，不是 SOP 觸發判定的依據——觸發判定永遠走 `rules/` 的確定性函式。
之後要做的「用 sub-agent 判斷該走哪條 SOP」還沒實作。

## 本機設定檔

以下檔案不應提交：

```text
backend/terraform/.terraform/
backend/terraform/.build/
*.tfstate
```

開發環境的 `terraform.tfvars` 與 `dev.tfbackend` 為版本控制檔，固定使用 `us-east-2`。
