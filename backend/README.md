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
│   └── handler.py                    # API Gateway Lambda handler
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

## 本機設定檔

以下檔案不應提交：

```text
backend/terraform/.terraform/
backend/terraform/.build/
*.tfstate
```

開發環境的 `terraform.tfvars` 與 `dev.tfbackend` 為版本控制檔，固定使用 `us-east-2`。
