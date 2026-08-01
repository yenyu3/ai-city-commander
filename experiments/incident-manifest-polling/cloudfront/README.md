# CloudFront 直讀組

此組模擬民眾端直接經 CloudFront 讀取：

```text
CloudFront /public/{date}/manifest.json
→ CloudFront /public/{date}/notices/{noticeId}.json
```

程式固定使用 `--delivery=cloudfront`，結果只會寫入本資料夾的 `results/`。

```bash
cd experiments/incident-manifest-polling/cloudfront
npm run run -- --profile=fast --runs=5
```

完整環境變數與 cleanup 說明見[上層 README](../README.md)。
