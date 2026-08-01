# 總報告：公開緊急公告讀取的規模化比較

實驗流程、環境設定、指標定義與可重現指令請見[實驗說明](README.md)。

## 執行摘要

在 100、1,000、10,000 client 的壅塞行動網路模擬中，CloudFront 直讀在可靠度與
tail latency 上均優於 Lambda proxy。差距會隨併發提高而擴大：1,000 client 時
CloudFront p95 快 59%，10,000 client 時快 85%，且成功率高 10.32 個百分點。

40,000 client 測試使單機 load generator 飽和，不能用來比較兩種 AWS 架構。

## 橫向比較

| 同時 client | CloudFront 成功率 | Lambda 成功率 | CloudFront p50 | Lambda p50 | CloudFront p95 | Lambda p95 | 可採用性 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 100 | 100% | 100% | 4.01 秒 | 4.16 秒 | 5.95 秒 | 6.42 秒 | 初步基準，差異小 |
| 1,000 | 99.8% | 99.8% | 3.54 秒 | 6.10 秒 | 5.90 秒 | 9.38 秒 | CloudFront 優勢明確 |
| 10,000 | 99.72% | 89.40% | 27.05 秒 | 48.08 秒 | 33.64 秒 | 62.31 秒 | 強力支持 CloudFront |
| 40,000 | 0.100% | 0.095% | 不具代表性 | 不具代表性 | 不具代表性 | 不具代表性 | 單機產生器飽和，不採用 |

## 請求放大

| 同時 client | CloudFront：manifest / notice / retry | Lambda：manifest / notice / retry | 重點 |
| ---: | --- | --- | --- |
| 100 | 116 / 115 / 15 | 117 / 112 / 12 | 差異接近隨機波動 |
| 1,000 | 1,137 / 1,138 / 138 | 1,646 / 1,145 / 145 | Lambda manifest 讀取增加 45% |
| 10,000 | 16,094 / 11,834 / 1,834 | 14,797 / 19,659 / 9,659 | Lambda notice retry 增加 427% |

## 架構決策

```text
公開、可快取、所有民眾皆可讀的 notice
  → CloudFront → public-results S3

需授權、需資料過濾、需依使用者情境動態產生的內容
  → API Gateway → Lambda
```

公開公告若走 Lambda proxy，併發升高時每次 retry 都會額外消耗 API Gateway、Lambda
與 S3 資源；CloudFront 直讀可將熱讀取分散到邊緣層，保留後端容量給事件處理與政府端
工作流程。

## 呈現建議

1. 使用 client 數為 X 軸（100、1,000、10,000；log scale），delivery p95 為 Y 軸，
   繪製 CloudFront 與 Lambda 兩條線。
2. 以堆疊／群組長條圖呈現各級距成功率。
3. 以 notice retry 數呈現高併發時的請求放大；10,000 client 是最具說服力的案例。
4. 40,000 client 獨立放在「工具限制與後續工作」頁，不要與正式架構結果同圖比較。

## 限制與下一步

- 每個級距目前只有一組 CloudFront／Lambda observation；正式結論應各重複至少 5 次，
  取每輪 p50／p95 的中位數。
- 網路為 application-level 模擬，非電信商基地台量測。
- 40,000 client 應改由分散式 load generator 重測，並串接 CloudWatch 服務端指標。
- 未來結果中的 `successRate` 會保留四位小數；舊 JSON 將 99.8% 四捨五入為 `1`，
  本報告一律以 `readyClients / totalClients` 重新計算。

## 分級報告

- [100 client](report-100-clients.md)
- [1,000 client](report-1000-clients.md)
- [10,000 client](report-10000-clients.md)
- [40,000 client](report-40000-clients.md)
