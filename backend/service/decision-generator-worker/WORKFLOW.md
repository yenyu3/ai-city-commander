# decision-generator-worker 工作流程

對應 `data/api.md` §7 的 Decision Worker Lambda。程式碼在
[`handler.py`](handler.py)，實際的判斷/快取/報告邏輯委派給
[`../decision_routing.py`](../decision_routing.py)。

**2026-08-01 改版**：這份文件描述的是新版「城市級 router + 聚焦生成」設計。
舊版（每次只認一個 `locationId`、每個地點各自獨立打 LLM）已經整個換掉——
背景是使用者指出舊設計把上下文切得太碎，agent 每次只看得到一個路段/站點的
數字，完全沒有跨地點的全局視野，而且 `locationId` 是必填、無法問「現在整個
城市狀況如何」。

## 三個階段（同一次 worker invocation 裡依序跑完）

- **Phase A — 分診（Router）**：`agent/router_agent.py::route_triggers()`，
  一次 LLM 呼叫，餵給它**全市**目前所有路段/站點的即時快照**加上前一筆快照**
  （讓它看得到趨勢，不是只看單一時間點的數字），以及目前所有進行中的事件。
  只負責回答「現在哪些 SOP 條款被觸發、在哪裡」，不產生詳細理由或民眾訊息
  （那是 Phase B 的工作）。每個 `scenarioAt` 只算一次，快取在
  `decisions/{scenarioAt}/_triggers.json`。
  - 沒有 LLM 可用時的備援：不是重寫一套規則，而是把現有的
    `decide_congestion`/`decide_accident`/`decide_signal_failure`/
    `decide_multilingual` 對每個路段/站點/事件都跑一次（跟舊版行為完全一樣），
    只是現在是一次掃過全部，不是被外部逐個查詢觸發。
  - SOP §3（`BS_MRT_BL17`）、§4（`BS_TPE_DOME`）**不**交給 Phase A 判斷——
    這兩個站點固定只有這兩個，直接無條件當候選丟給 Phase B，讓
    `decide_mrt_diversion`/`decide_dome_dispersal` 自己決定真的有沒有觸發
    （§4 的「歷史峰值 ≥ 30000」門檻本來就需要完整歷史資料，Phase A 的
    「目前+前一筆」快照看不到，硬要它猜反而不準）。
  - **Phase A 看到的是加工過的 facts，不是只有原始欄位**（2026-08-01 補強）：
    每個路段多帶一個 `is_city_trigger_segment` 布林值（是不是 SOP 第1條認定
    的觸發路段），每個 active incident 多帶一份 `candidate_alternative_routes`
    （`agent/facts.py::build_accident_candidates()`，跟 `decide_accident()`
    自己用的是同一份，只是抽出來共用）。這些欄位本來就是 Phase B 會用到、
    已經在 `_CityData` 裡撈好的資料重新整理成 JSON，不是額外的 DB/LLM 呼叫，
    所以幾乎零成本——讓 Phase A 判斷時直接用真實結構化資料，不用自己從 SOP
    文字反推「這個路段算不算觸發路段」，或憑空猜「這個候選路線容量夠不夠、
    在不在上游」。

- **Phase B — 聚焦生成**：對 Phase A 找出的每個候選，呼叫既有的
  `agent/facts.py::decide_*()`（完全沒改，一樣是「facts 進、LLM 判斷+生成
  理由/民眾訊息出」）。**Phase B 自己算出的 `triggered` 才是最終依據**，
  不是 Phase A 的猜測——如果 Phase A 猜錯了、Phase B 認為其實沒觸發，就不會
  出現在最終結果裡（但還是會被快取，避免下次重算）。每一項照舊存進
  `s3_cache.py` 既有的 key 格式，完全沒變。
  - **建議書產生**（`report_builder.py`，沿用先前的邏輯）：只有
    `sopSectionId` 屬於 {2, 3, 5}（三個事件類型對應的條款）**而且**這個
    候選有對到一個 active incident 的 `event_id`、**而且**真的觸發了，才會
    寫入 `emergency-reports/{date}/{eventId}/report-v1.json`。congestion
    （§1）、dome_dispersal（§4，没有對應的 live_incidents.json 事件類型）、
    multilingual（§6）都不會產生建議書。

- **Phase C — 聚焦敘事**：`agent/router_agent.py::narrate_for_focus()`，
  拿 Phase B 所有「真的觸發」的項目（含各自的民眾版訊息），加上呼叫端這次
  問的「關注地點」（可能沒有），生成**一段**融合文字：
  - 有給關注地點：先講這個地點本身（沒觸發就講狀況正常），其他地方有觸發
    的話會順帶提醒——這就是使用者要的「A 站順暢，但避免前往 B 站」。
  - 沒給關注地點：對整體狀況做一段總結。
  - 完全沒有任何觸發：一句話說明目前一切正常。
  快取在 `decisions/{scenarioAt}/_summary/{locationId 或 "_global"}.json`
  ——每個不同的關注焦點各自快取一份，但都共用同一份 Phase A/B 結果，所以
  第二個問不同焦點的呼叫只需要付 Phase C 這一次輕量呼叫的成本。

## 誰會觸發它、怎麼觸發

- 一律透過 [`worker_invoke.invoke_async()`](../worker_invoke.py) 非同步呼叫，
  fire-and-forget，呼叫端不等結果（部署在 AWS 時是真的 `boto3` Lambda
  `Invoke(InvocationType="Event")`；本機開發時是背景 daemon thread）。
- 兩個呼叫來源：
  1. **`GET /api/decisions` cache miss**（[`decision/handler.py`](../decision/handler.py)）——
     `locationId` 現在是**選填**：帶了就代表「這次的聚焦敘事要針對這個地點」，
     不帶就是要全域摘要。不管有沒有帶，觸發的都是同一個城市級 sweep。
  2. **`POST /api/incidents` 建立事件後**（[`incident/handler.py`](../incident/handler.py)）——
     best-effort 預熱，帶 `forceRefresh: true`（不是特定 `locationId`）。
     原因：如果這個 `scenarioAt` 的 sweep 在這個事件建立**之前**就已經被
     快取過，那份舊快取不會知道這個新事件的存在，之後查詢會一直看不到它，
     所以用 `forceRefresh` 強制 Phase A 重新掃一次（Phase B/C 還是正常走
     cache-aside，只有 Phase A 被強制刷新）。
- `automation.tf` 的 `rate(5 minutes)` EventBridge 排程
  （`{"source": "eventbridge", "mode": "scheduled"}`）維持原本的 no-op，
  沒有因為這次改版而變動——這個 demo 全部跑在呼叫端帶入的模擬時鐘
  `scenarioAt` 上，不是真實時間，週期性排程沒有明確答案該去掃哪個
  `scenarioAt`，沒有硬猜一個語意出來。

## 15 分鐘快取時槽（`api_common.decision_snapshot_at`）

`decision/handler.py` 跟這支 worker 的 handler 現在都會先把收到的 `scenarioAt`
用 `api_common.decision_snapshot_at()` 無條件捨去到 15 分鐘整（例如
`22:07` 會被捨去成 `22:00`），才拿去查/存快取。這跟前面「Phase A 找『前一筆
快照時間』」是兩件不同的事，不要搞混：

- **這裡（快取時槽）**：決定「這次查詢/計算要用哪一把 S3 快取 key」，目的是
  讓同一個 15 分鐘視窗內、時間戳不完全一樣的多次查詢（例如前端每幾秒 poll
  一次）都能共用同一份已經算好的結果，不用每次都重新觸發整套三階段流程。
  `decision/handler.py` 的回應會多帶 `resolvedScenarioAt`（實際用的時槽）跟
  `ageMinutes`（原始查詢時間跟這個時槽差多少分鐘），讓呼叫端知道自己拿到的
  結果是不是完全對得上自己問的那個確切時間點。
- **Phase A 的「前一筆快照」**：決定 router 拿到的趨勢比較基準是哪個時間點
  的路段/站點資料，跟快取 key 完全無關，用的是 `db.fetch_previous_traffic_timestamp`
  查資料庫裡實際存在的前一筆取樣時間（不是固定往前推 15 分鐘，因為
  `city_traffic_flow.csv`/`signaling_crowd_density.csv` 的取樣間隔本身不
  均勻，21:00 前是整點/半小時一次，之後才變 15 分鐘）。

## 收到 reactive 請求（`{scenarioAt, locationId?, forceRefresh?}`）後做什麼

進 `decision_routing.py::run_worker_phases()`：

1. 解析 `scenarioAt`；缺這個欄位回 `400`。`locationId`/`forceRefresh`
   都是選填。這支 worker 自己也會呼叫 `decision_snapshot_at()` 把收到的
   `scenarioAt` 捨去到 15 分鐘時槽——不假設呼叫端已經捨去過（`incident/handler.py`
   的 `forceRefresh` 呼叫就是直接傳原始 `context["scenarioAt"]`，沒有先捨去），
   所以這裡自己再捨去一次，確保不管誰觸發、傳的是不是精確時間，最後寫進
   S3 的 key 都是同一把。
2. `db.connect()` 接 RDS；連不上回 `503`。
3. 一次性撈出全市資料（`_fetch_city_data`）：目前+前一筆的全部路段流量、
   目前+前一筆的全部站點人流、目前所有 active incidents、完整路網拓撲
   （`decide_accident` 需要）。Phase A/B/C 共用這一份，不重複查。
4. Phase A（`_ensure_city_sweep`）→ Phase B（`_ensure_decisions`）→
   Phase C（`_ensure_narrative`，只針對這次呼叫問的 `locationId`）。
5. `conn.commit()`、`conn.close()`。
6. 回傳 `{"status": "ready", "locationId", "scenarioAt", "resolvedScenarioAt", "triggeredCount"}`
   ——呼叫端本來就是 fire-and-forget，這個回傳值目前沒有人讀，純粹方便
   本機測試直接呼叫這支 handler 時看結果。`scenarioAt` 是原始收到的字串，
   `resolvedScenarioAt` 是捨去到 15 分鐘時槽之後、實際拿去查/存快取用的值。

## `GET /api/decisions` 的回應長什麼樣（`decision/handler.py`）

純 cache-only 讀取（`decision_routing.fetch_cached_view`，完全不碰
RDS/LLM）。命中時 `200`：

```json
{
  "meta": {
    "scenarioAt": "呼叫端原始傳入的時間",
    "resolvedScenarioAt": "捨去到15分鐘時槽後的時間",
    "ageMinutes": "原始時間跟這個時槽差幾分鐘",
    "cacheStatus": "hit（剛好整槽） 或 slot_hit（同一時槽但非整點查詢）",
    "...": "..."
  },
  "focus": {"locationId": "BS_MRT_BL18"} | null,
  "situationSummary": "一段融合文字，聚焦 focus（如果有）但仍帶到其他地方",
  "decisions": [
    {"decisionId", "sopSectionId", "kind", "locationId", "eventId",
     "summary": {"aiText", "sopRefs"}, "recommendedActions", "estimatedRecovery",
     "reroute", "publicMessage"}
  ]
}
```

未命中時 `202` + 觸發 worker，`retryAfterSeconds` 沿用舊行為。

**`decisions[]` 不受 `locationId` 影響，永遠是全市目前所有真的觸發中的項目
（Phase B 的完整結果），不管有沒有帶 `locationId`、帶了哪個，內容都一樣**
——只有 `situationSummary` 才會因為 `locationId` 不同而變。這是刻意的設計
選擇：`decisions[]` 給前端結構化的「全市當下發生了什麼」完整資料（例如
在地圖上標出每個觸發點），`situationSummary` 給的是「幫你把這些濃縮成一段
話、並聚焦在你關心的地方」的文字。代價是觸發項目一多，單次回應就會變大；
如果之後要改成 `decisions[]` 也跟著 `locationId` 過濾/裁切，這是
`decision/handler.py::handler()` 裡組 response 的地方要改，`fetch_cached_view`
本身已經回傳完整的 pairs，過不過濾是 handler 這層的決定，不用動
`decision_routing.py`。

**這是對 `data/api.md` §4 目前文件內容的實質變更**（`locationId` 從必填變
選填、回應從單一 `aiDecision` 變成 `decisions[]` 陣列 + `situationSummary`）
——我沒有自己去改那份文件，會另外把確切要改的段落告訴使用者。

## 目前不做的事（刻意，不是漏做）

- 排程觸發（`source=="eventbridge"`）不會主動預先掃任何 `scenarioAt`
  ——見上面「怎麼觸發」的說明，這點沒有因為這次改版而改變。
- 算完決策、寫完建議書之後，**不會**自動組多語簡訊、也不會自動呼叫
  `POST /api/publication` 發布——那條自動化路徑還沒做。
