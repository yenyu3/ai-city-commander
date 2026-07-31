# Backend：全新環境部署

以下流程適用於尚未建立 Terraform state、RDS、S3、CloudFront、API Gateway 或
Lambda 的 AWS 帳號／區域。會建立完整基礎設施並將 Demo 資料寫入新的 RDS；不要用於
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
環境設定都集中在此檔案：`aws_region`、`project_name`、RDS 規格、選填的 Bedrock 設定、
兩個結果 bucket 名稱與 CORS origin。

S3 bucket 名稱為全 AWS 共用；若預填名稱已被占用，請直接修改
`internal_results_bucket_name` 與 `public_results_bucket_name` 為不同且唯一的名稱。

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

部署會建立：VPC、RDS、Secrets Manager、S3、CloudFront、API Gateway、ECR、各 Lambda、
EventBridge 五分鐘排程與 SNS。

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
