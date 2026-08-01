# Lambda proxy 對照組

此組模擬前端經 API Gateway 與 Lambda，再由 Lambda 讀取同一個 public-results
bucket：

```text
GET /api/experiments/public-notices?date={date}
GET /api/experiments/public-notices?date={date}&noticeId={noticeId}
```

程式固定使用 `--delivery=lambda`，結果只會寫入本資料夾的 `results/`。先部署
Terraform，讓 `notice-proxy` Lambda 與 route 存在後再執行：

```bash
cd experiments/incident-manifest-polling/lambda-proxy
npm run run -- --profile=fast --runs=5
```

完整環境變數與 cleanup 說明見[上層 README](../README.md)。
