# 100 client 報告：控制基準

## 設定

- Profile：`crowded-cell`（1,200 ms 延遲、±800 ms jitter、100 Kbps／cell、12% 模擬失敗率）。
- 同時 client：100；notice 最多重試 2 次。
- 兩組依序執行，使用相同 `scenarioAt`：`2026-05-22T22:10:00+08:00`。

## 結果

| 指標 | CloudFront | Lambda proxy | Lambda 差異 |
| --- | ---: | ---: | ---: |
| 成功 | 100 / 100 | 100 / 100 | 0 個百分點 |
| delivery p50 | 4.01 秒 | 4.16 秒 | +0.15 秒（+4%） |
| delivery p95 | 5.95 秒 | 6.42 秒 | +0.48 秒（+8%） |
| manifest requests | 116 | 117 | +1 |
| notice requests | 115 | 112 | -3 |
| notice retries | 15 | 12 | -3 |

## 判讀

在 100 client 下兩組的成功率相同、延遲差距很小。這表示在低到中等併發時，API
Gateway + Lambda 的額外 hop 尚未形成顯著瓶頸；單一 repetition 不足以宣稱 4% 的
p50 差異具有統計意義。

原始資料：[CloudFront](../cloudfront/results/fanout-cloudfront-crowded-cell-2026-08-01T13-54-53-574Z.json)、[Lambda proxy](../lambda-proxy/results/fanout-lambda-crowded-cell-2026-08-01T13-54-52-200Z.json)。
