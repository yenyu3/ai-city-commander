# 40,000 client 報告：單機產生器飽和點

## 設定

- Profile：`crowded-cell`；40,000 client 分布在 1,000 個 cells，平均每 cell 40 人。
- 有效下行頻寬：2.5 Kbps／client。
- 同一 `scenarioAt`：`2026-05-25T22:10:00+08:00`；兩組依序執行。

## 觀測結果

| 指標 | CloudFront | Lambda proxy |
| --- | ---: | ---: |
| 成功 | 40 / 40,000（0.100%） | 38 / 40,000（0.095%） |
| manifest requests | 174,074 | 219,765 |
| notice requests | 45 | 1,418 |
| delivery p50（僅成功樣本） | 12.78 分鐘 | 6.44 分鐘 |
| delivery p95（僅成功樣本） | 12.79 分鐘 | 15.90 分鐘 |

## 結論：本輪不納入架構效能比較

此結果主要反映**單一 Node.js 產生器／本機網路／socket 資源飽和**，而不是平台真實
容量。兩組超過 99.9% client 無法完成，成功樣本只有 40 與 38 筆；因此 Lambda p50
表面較低沒有比較意義，也不能解讀為 Lambda proxy 較快。

本輪可用作工具容量的警戒線：單機工具不適合據此推論 40,000 真實使用者的系統能力。
若要驗證此級距，需使用多台 load generator 或 AWS 分散式產生器，並從 CloudWatch 取得
API Gateway、Lambda concurrency／throttle、S3 與 CloudFront 的服務端指標。

原始資料：[CloudFront](../cloudfront/results/fanout-cloudfront-crowded-cell-2026-08-01T15-24-14-217Z.json)、[Lambda proxy](../lambda-proxy/results/fanout-lambda-crowded-cell-2026-08-01T15-37-50-489Z.json)。
