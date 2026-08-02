# decision-generator-worker 流程圖

搭配 [`WORKFLOW.md`](WORKFLOW.md) 文字說明看。這份只畫流程，欄位/格式細節在 WORKFLOW.md。

## 入口分流：`mode` 決定走哪條路

worker 收到 `{mode, scenarioAt, locationId? | eventId?}`，`mode` 完全決定接下來做什麼、寫到哪——不是看 SOP 種類、不是看有沒有 `eventId`。

```mermaid
flowchart TD
    Start(["worker 收到 reactive 請求<br/>{mode, scenarioAt, locationId? | eventId?}"]) --> ParseMode{"mode?"}
    ParseMode -- "decision<br/>(GET /api/decisions cache miss)" --> DecisionFlow["run_worker_phases()"]
    ParseMode -- "incident<br/>(POST /api/incidents 後)" --> IncidentFlow["run_incident_flow()"]
```

## `mode: "decision"` —— 城市全域 sweep

只算「一般決策」（congestion/mrt_diversion/dome_dispersal/multilingual），**不含** accident/signal_failure（那是 incident 的工作），只寫 `decisions/`。

```mermaid
flowchart TD
    A["scenarioAt 用 decision_snapshot_at() 捨去到 15 分鐘時槽"] --> B["_fetch_city_data<br/>目前路段流量 + 目前站點人流 + 進行中事件 + 路網拓撲"]
    B --> C{"Phase A：_ensure_city_sweep<br/>快取命中？"}
    C -- "命中" --> F1["讀快取 triggers"]
    C -- "未命中" --> D["_deterministic_city_sweep()<br/>純 Python，非 LLM"]
    D --> D1["§1 congestion：<br/>rules/congestion_tier.check_city_response()<br/>（僅 RD_TPE_001/002 兩個城市觸發路段）"]
    D --> D2["§6 multilingual：<br/>rules/multilingual_check.check_multilingual_needed()<br/>（roaming ≥ 30%）"]
    D --> E["_always_on_triggers()<br/>固定候選：BS_MRT_BL17（§3）、BS_TPE_DOME（§4）<br/>不需要判斷，這兩站永遠是候選"]
    D1 --> F2["合併候選清單"]
    D2 --> F2
    E --> F2
    F2 --> F3["寫入快取 decisions/{scenarioAt}/_triggers.json"]
    F1 --> G
    F3 --> G["Phase B：_ensure_decisions<br/>每個候選 cache-aside"]
    G --> H{"逐一候選<br/>快取命中？"}
    H -- "命中" --> I1["讀快取 Decision"]
    H -- "未命中的全部候選" --> I2["ThreadPoolExecutor（上限 20）平行送出"]
    I2 --> J1["decide_congestion()"]
    I2 --> J2["decide_mrt_diversion()"]
    I2 --> J3["decide_dome_dispersal()"]
    I2 --> J4["decide_multilingual()"]
    J1 --> K["每個都是 LLM 優先，rules/ 備援<br/>Decision.triggered 才是最終依據"]
    J2 --> K
    J3 --> K
    J4 --> K
    K --> L["各自寫入 s3_cache（既有 key 格式）"]
    I1 --> M
    L --> M["只保留 triggered=true 的 pairs"]
    M --> N{"Phase C：_ensure_narrative<br/>（這次呼叫要的 focus）快取命中？"}
    N -- "命中" --> R["讀快取 Narrative"]
    N -- "未命中" --> O["narrate_for_focus(items, locationId?, focusName?)"]
    O --> P["ThreadPoolExecutor 平行送出"]
    P --> P1["citizen 版摘要 LLM 呼叫"]
    P --> P2["government 版摘要 LLM 呼叫"]
    P1 --> Q["組成 Narrative"]
    P2 --> Q
    Q --> Q1["（decision sweep 這裡不會有 accident 項目，<br/>所以不會觸發 routing-variant 平行呼叫）"]
    Q1 --> S["寫入快取 decisions/{scenarioAt}/_summary/{locationId 或 _global}.json"]
    R --> T(["回傳 pairs + Narrative<br/>只寫 decisions/，不產生報告/公告"])
    S --> T
```

## `mode: "incident"` —— 單一事件判斷

只處理指定的 `eventId`，**不做城市 sweep**。up to 3 個 SOP 檢查全部無條件執行（沒有候選篩選這一步——每個送進來的事件都會被問，不像 decision sweep 需要先篩候選）。

```mermaid
flowchart TD
    A["scenarioAt 用 parse_scenario_at() 解析<br/>（精確時間，不做 15 分鐘捨去）"] --> B["_fetch_city_data + db.fetch_incident(eventId)<br/>（不受 occurred_at 可見度篩選）"]
    B --> C["3 個 SOP 檢查全部無條件執行<br/>ThreadPoolExecutor 平行送出"]
    C --> D1["decide_accident()　§2<br/>永遠檢查"]
    C --> D2["decide_signal_failure()　§5<br/>永遠檢查"]
    C --> D3{"affected_segment 是<br/>人流站點？"}
    D3 -- "是" --> D3a["decide_mrt_diversion()　§3"]
    D3 -- "否" --> D3b["跳過"]
    D1 --> E["觸發的各自寫入<br/>incidents/{date}/{eventId}/decisions/{scenarioAt}/{kind}.json"]
    D2 --> E
    D3a --> E
    E --> F["pairs = 觸發的 (Trigger, Decision) 清單<br/>（可能是空的——沒有一條符合也是合法結果）"]
    F --> G["_write_incident_report_and_notice()<br/>無條件呼叫，即使 pairs 是空的"]
    G --> H["items = [decision_detail(trig, decision) for pairs]<br/>（pairs 空 → items 也是空陣列）"]
    H --> I["narrate_for_focus(items, incident.affected_segment, focusName)"]
    I --> J["ThreadPoolExecutor 平行送出"]
    J --> J1["citizen 版摘要 LLM 呼叫"]
    J --> J2["government 版摘要 LLM 呼叫"]
    J --> J3{"items 裡有 accident 項目<br/>且可行候選路徑 ≥ 2？"}
    J3 -- "是，每個這樣的項目各一個" --> J3a["routing-variant LLM 呼叫<br/>（headline/text/recommendedActions<br/>× 每個可行路徑，機率由剩餘容量決定論算出）"]
    J3 -- "否（0 或 1 條候選，或非 accident）" --> J3b["citizen.routingVariants 維持空陣列"]
    J1 --> K["組成 Narrative<br/>citizen.routingVariants 併入 J3a 的結果"]
    J2 --> K
    J3a --> K
    J3b --> K
    K --> L["report_builder.build_and_save_report()<br/>寫 emergency-reports/{date}/{eventId}/report-v1.json + .pdf"]
    K --> M["s3_common.publish_public_notice()<br/>寫 public/{date}/notices/PUB_{eventId}_v1.json<br/>+ 更新 public/{date}/manifest.json"]
    L --> N(["回傳 pairs<br/>（不管有沒有觸發，report + notice 都已經誠實寫出<br/>「觸發了 X/Y/Z」或「已評估，無觸發」"])
    M --> N
```

## 兩條路徑的關鍵差異

| | `mode: "decision"` | `mode: "incident"` |
|---|---|---|
| 處理範圍 | 全市 sweep | 單一 `eventId` |
| Phase A（候選篩選） | 有（決定論：§1/§6 算出來、§3/§4 固定候選） | 沒有——3 個檢查全部無條件執行 |
| SOP 條文 | §1/§3/§4/§6 | §2/§5，條件符合再加 §3 |
| 寫入位置 | `decisions/` | `incidents/{date}/{eventId}/` + `emergency-reports/` + `public/` |
| 報告/公告 | 不產生 | 一律產生（含沒有觸發的情況） |
| `citizen.routingVariants` | 永遠空（不會有 accident 項目） | 有 accident 且候選 ≥ 2 條才會有內容 |
| scenarioAt 處理 | 捨去到 15 分鐘時槽 | 精確時間，不捨去 |
