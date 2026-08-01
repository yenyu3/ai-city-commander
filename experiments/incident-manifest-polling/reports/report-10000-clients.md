# 10,000 client 報告：高併發壅塞測試

## 設定

- Profile：`crowded-cell`；10,000 client 分布在 100 個 cells，平均每 cell 100 人。
- 有效下行頻寬：1 Kbps／client。
- 同一 `scenarioAt`：`2026-05-24T22:10:00+08:00`；兩組依序執行。

## 結果

| 指標 | CloudFront | Lambda proxy | Lambda 差異 |
| --- | ---: | ---: | ---: |
| 成功 | 9,972 / 10,000（99.72%） | 8,940 / 10,000（89.40%） | -10.32 個百分點 |
| delivery p50 | 27.05 秒 | 48.08 秒 | +21.03 秒（+78%） |
| delivery p95 | 33.64 秒 | 62.31 秒 | +28.67 秒（+85%） |
| manifest requests | 16,094 | 14,797 | -1,297 |
| notice requests | 11,834 | 19,659 | +7,825（+66%） |
| notice retries | 1,834 | 9,659 | +7,825（+427%） |

## 判讀

在 10,000 client 下，CloudFront 仍維持 99.72% 成功率；Lambda proxy 成功率降至
89.40%，且 p95 超過一分鐘。Lambda proxy 的 notice retry 顯著增加，表示失敗後的
重試流量會進一步壓迫 API Gateway、Lambda 與 S3 路徑，形成請求放大。

此級距是目前最有力的架構決策證據：公開公告的熱讀取路徑應維持 CloudFront 直讀。

原始資料：[CloudFront](../cloudfront/results/fanout-cloudfront-crowded-cell-2026-08-01T14-00-35-525Z.json)、[Lambda proxy](../lambda-proxy/results/fanout-lambda-crowded-cell-2026-08-01T14-02-39-124Z.json)。
