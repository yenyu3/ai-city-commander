# 公開公告讀取效能實驗

兩組使用相同的事件注入、網路模擬與 cleanup 邏輯，但程式入口與結果完全分開：

```text
incident-manifest-polling/
├── cloudfront/                 # 正式架構：前端直讀 CloudFront + S3
│   ├── run.mjs
│   └── results/                 # 已有 CloudFront 實驗資料
├── lambda-proxy/               # 對照組：API Gateway → Lambda → S3
│   ├── run.mjs
│   └── results/                 # Lambda 實驗資料
└── shared/                     # 共用注入、網路模擬、統計與 cleanup 邏輯
```

| 組別 | Manifest／notice 讀取路徑 | 執行目錄 |
| --- | --- | --- |
| CloudFront | Browser → CloudFront → public-results S3 | `cloudfront/` |
| Lambda proxy | Browser → API Gateway → Lambda → public-results S3 | `lambda-proxy/` |

## 共用環境設定

```bash
export API_BASE='https://<api-id>.execute-api.us-west-2.amazonaws.com'
export PUBLIC_RESULTS_BASE='https://<cloudfront-domain>'
export AWS_PROFILE='ai-city'
export AWS_REGION='us-west-2'
export INTERNAL_RESULTS_BUCKET='ai-city-commander-internal-results'
export PUBLIC_RESULTS_BUCKET='ai-city-commander-public-results'
export AURORA_CLUSTER_ARN='arn:aws:rds:...:cluster:ai-city-commander-dev-aurora-postgres'
export DATABASE_SECRET_ARN='arn:aws:secretsmanager:...:secret:ai-city-commander-dev/database-...'
```

每次會 POST 一個唯一 `EXP_` 事件、取得 manifest 與 notice，輸出 JSON／CSV，
並自動 cleanup 兩輪。cleanup 會刪除 Aurora 的事件與 job、internal S3 artefact、
public notice，及更新 manifest；只允許刪除 `EXP_` 前綴。

## 兩組都跑相同 profile

```bash
cd cloudfront
npm run run -- --profile=fast --runs=20

cd ../lambda-proxy
npm run run -- --profile=fast --runs=20
```

再依序跑 `slow-3g` 與 `unstable`。比較各自 `results/` 的 JSON summary：成功率、
`endToEndMs` 的 p50/p95、`manifestPolls` 與 `noticeFetchMs`。

`lambda-proxy/` 必須先以 Terraform 部署 `notice-proxy` Lambda；CloudFront 組不需
新增部署。

## 壅塞小區、同時使用者與重試風暴

一般 `npm run run` 是單一使用者體驗測試。使用 `npm run load` 會只注入 **一個**
事件，接著讓多個 client 同時讀取它；每個 client 都會經歷 manifest → notice。

```bash
cd cloudfront
npm run load -- --profile=crowded-cell --clients=100 --notice-retries=2

cd ../lambda-proxy
npm run load -- --profile=crowded-cell --clients=100 --notice-retries=2
```

`--shared-cell=true` 是預設值。`--cells` 指定模擬小區數，工具會以
`每小區頻寬 × cells ÷ clients` 算出每位使用者可用頻寬；例如 10,000 人、100 個
小區、每小區 100 Kbps，等於每人約 1 Kbps。`--notice-retries` 會對失敗的 notice
下載做 exponential backoff 加 jitter 重試，並在結果中記錄總重試數與請求量。

更嚴苛的 profile：

| Profile | 情境 |
| --- | --- |
| `crowded-cell` | 演唱會／疏散現場的壅塞小區：高延遲、100 Kbps、12% 失敗率 |
| `coverage-edge` | 訊號邊緣或移動中：更高延遲、40 Kbps、25% 失敗率 |

單機產生器預設最多可測 40,000 個 client。超過 10,000 時必須明確加上
`--confirm-large-load=true`；這是避免誤觸的保護，不代表單一筆電能可靠地建立
40,000 條同時連線。此類結果應標示為「單機產生器壓力測試」；正式容量結論應以
分散式 load generator 重做。
