# 1,000 client 報告：中等併發壅塞測試

## 設定

- Profile：`crowded-cell`；1,000 client 分布在 100 個 cells，平均每 cell 10 人。
- 有效下行頻寬：10 Kbps／client。
- 同一 `scenarioAt`：`2026-05-23T22:10:00+08:00`；兩組依序執行。

## 結果

| 指標 | CloudFront | Lambda proxy | Lambda 差異 |
| --- | ---: | ---: | ---: |
| 成功 | 998 / 1,000（99.8%） | 998 / 1,000（99.8%） | 0 個百分點 |
| delivery p50 | 3.54 秒 | 6.10 秒 | +2.55 秒（+72%） |
| delivery p95 | 5.90 秒 | 9.38 秒 | +3.48 秒（+59%） |
| manifest requests | 1,137 | 1,646 | +509（+45%） |
| notice requests | 1,138 | 1,145 | +7 |
| notice retries | 138 | 145 | +7 |

## 判讀

在 1,000 client 下，兩組可靠度仍相同，但 Lambda proxy 的 p50 與 p95 明顯提高，
且 manifest 請求多出 45%。這是第一個清楚顯示公開讀取熱路徑經過 API Gateway 與
Lambda 會放大 tail latency 的負載級距。

原始資料：[CloudFront](../cloudfront/results/fanout-cloudfront-crowded-cell-2026-08-01T13-58-36-947Z.json)、[Lambda proxy](../lambda-proxy/results/fanout-lambda-crowded-cell-2026-08-01T13-59-32-312Z.json)。
