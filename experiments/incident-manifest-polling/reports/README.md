# 實驗說明與重現方式

本目錄收錄公開緊急公告讀取的實驗結果與方法。比較的問題是：當許多民眾在事件發生後同時輪詢公告時，應由前端直接經 CloudFront 讀取公開 S3 物件，還是經 API Gateway 與 Lambda proxy 轉送？

## 比較組別

| 組別 | 前端讀取路徑 | 用途 |
| --- | --- | --- |
| 實驗組：CloudFront | Browser → CloudFront → public-results S3 | 正式公開公告架構 |
| 對照組：Lambda proxy | Browser → API Gateway → Lambda → public-results S3 | 驗證多一層 API 轉送的成本 |

兩組均使用相同的事件注入 API、相同的 public manifest／notice 資料格式、相同的網路 profile 與 cleanup 邏輯；唯一差異是公告資料的讀取路徑。

## 單次實驗流程

1. 工具透過 `POST /api/incidents` 注入一筆唯一的 `EXP_` 前綴測試事件。
2. 背景處理流程將公告寫入 `public/{date}/notices/{noticeId}.json`，並更新 `public/{date}/manifest.json`。
3. 每個模擬 client 先輪詢 manifest，發現 notice 後再下載對應 notice JSON。
4. 記錄端到端時間、成功／失敗、manifest 與 notice 請求數，以及重試次數。
5. 結束後自動執行兩輪 cleanup：刪除 Aurora 中的實驗事件與 job、內部／公開 S3 物件，並重新寫回 manifest。cleanup 僅接受 `EXP_` 前綴的事件 ID。

端到端時間定義為：送出事件注入請求後，到該 client 成功取得 notice JSON 為止；因此包含事件處理、manifest 可見與公告下載的等待時間。

## 網路與負載模型

目前分級報告使用 `crowded-cell` profile，模擬活動現場行動網路壅塞：基礎延遲 1,200 ms、jitter 800 ms、每小區下行 100 Kbps、請求失敗率 12%、單次逾時 45 秒。

`--cells` 將同時使用者分配至多個模擬小區；每位使用者的有效下行頻寬為：

```text
每小區下行頻寬 × 小區數 ÷ client 數
```

notice 下載失敗會以 exponential backoff 加 jitter 重試，重試造成的額外請求會計入結果。這是 application-level 網路模型，用於比較兩條架構路徑；並非電信商基地台的實測。

## 指標定義

| 指標 | 定義 |
| --- | --- |
| 成功率 | `readyClients / totalClients`；成功代表取得 notice JSON |
| p50 | 成功 client 端到端時間的中位數 |
| p95 | 成功 client 端到端時間的第 95 百分位，用以觀察慢速使用者體驗 |
| manifest / notice requests | 所有 client 實際發出的各類讀取請求總數 |
| retries | notice 初次失敗後產生的重試次數 |

## 如何重現

先設定共用環境變數：

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

在兩組依序執行相同負載；為避免資料互相影響，應使用相同 `scenarioAt`，但讓前一組 cleanup 完成後再執行下一組：

```bash
cd ../cloudfront
npm run load -- --profile=crowded-cell --clients=1000 --cells=100 --notice-retries=2

cd ../lambda-proxy
npm run load -- --profile=crowded-cell --clients=1000 --cells=100 --notice-retries=2
```

`lambda-proxy` 組須先以 Terraform 部署 `notice-proxy` Lambda；CloudFront 組不需新增後端服務。原始 JSON／CSV 分別位於 `../cloudfront/results/` 與 `../lambda-proxy/results/`。

## 解讀與限制

- 100、1,000、10,000 client 的資料可用於比較；40,000 client 已使單機 load generator 飽和，僅用於揭露測試工具限制，不能據此比較 AWS 架構效能。
- 每個規模目前各有一輪 observation。正式容量結論應於每個組合至少重複五輪，再取 p50／p95 的中位數。
- 服務端容量仍應搭配 CloudWatch 的 CloudFront、API Gateway、Lambda concurrency／throttle 與 S3 指標驗證。

## 報告索引

- [總報告：規模化比較](report-summary-scale-comparison.md)
- [100 client](report-100-clients.md)
- [1,000 client](report-1000-clients.md)
- [10,000 client](report-10000-clients.md)
- [40,000 client（產生器限制）](report-40000-clients.md)
