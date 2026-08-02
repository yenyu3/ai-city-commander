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

- **Phase A — 候選篩選**：`decision_routing.py::_deterministic_city_sweep()`，
  純 Python、不呼叫 LLM。只負責回答「現在哪些 SOP 條款被觸發、在哪裡」，
  不產生詳細理由或民眾訊息（那是 Phase B 的工作）。每個 `scenarioAt` 只算
  一次，快取在 `decisions/{scenarioAt}/_triggers.json`。
  - **2026-08-02 改版**：這裡原本是 `agent/router_agent.py::route_triggers()`，
    一次 LLM 呼叫餵給它全市快照＋前一筆快照＋所有進行中事件，要求它列出
    §1/§6 的觸發清單。拿掉的原因：§1（`is_city_trigger_segment` 布林值＋
    飽和度門檻）、§6（roaming ≥ 30%）的觸發條件本來就是純算術，prompt 裡
    甚至明講「不用自己反推、只要照抄這個布林值」——LLM 在這裡從來沒有真的
    做判斷，只是被要求把一個已經算好的答案原封不動列出來。真實跑
    `eval/router_precision_recall.py`（已刪除）量到 recall 低到 0.44、
    precision 卻是滿分 1.0，證實不是誤判，是尖峰時段同時十幾個候選時，
    LLM 在一次生成裡漏列的機率變高——這是枚舉型任務的已知弱點，不是校準
    問題，所以直接改用 `rules/congestion_tier.py::check_city_response`／
    `rules/multilingual_check.py::check_multilingual_needed`（跟
    `eval/llm_vs_rules_consistency.py` 拿來當 ground truth 的同一組決定論
    函式）在 Python 端直接算,recall/precision 因為不是用猜的，直接變成
    100%。
  - SOP §3（`BS_MRT_BL17`）、§4（`BS_TPE_DOME`）維持原本作法，**不**交給
    Phase A 判斷——這兩個站點固定只有這兩個，直接無條件當候選丟給
    Phase B，讓 `decide_mrt_diversion`/`decide_dome_dispersal` 自己決定真的
    有沒有觸發（§4 的「歷史峰值 ≥ 30000」門檻本來就需要完整歷史資料，
    Phase A 的「目前+前一筆」快照看不到，硬要它猜反而不準）。
  - **只做一般決策**：Phase A/B 只產生 congestion（§1）、mrt_diversion
    （§3）、dome（§4）、multilingual（§6）。§2/§5 從來就不是 Phase A 的候選
    集合的一部分——那是 **incident API 入口**（見下面「Incident API 入口」）
    的職責。decision 跟 incident 的界線由「打哪個 API 進來」決定（worker
    收到的 `mode`），不是 SOP 種類，也不是 event_id 有沒有值（decision
    sweep 產生的項目 `eventId` 也已經改成永遠是 `null`，不會再跟同地點的
    incident 互相掛勾，見 `decision_routing.py` 內的說明）。

- **Phase B — 聚焦生成**：對 Phase A 找出的每個候選，呼叫既有的
  `agent/facts.py::decide_*()`（完全沒改，一樣是「facts 進、LLM 判斷+生成
  理由/民眾訊息出」）。**Phase B 自己算出的 `triggered` 才是最終依據**，
  不是 Phase A 的猜測——如果 Phase A 猜錯了、Phase B 認為其實沒觸發，就不會
  出現在最終結果裡（但還是會被快取，避免下次重算）。每一項照舊存進
  `s3_cache.py` 既有的 key 格式，完全沒變。**這裡不產生建議書**——建議書是
  incident API 入口的產物（見下面「Incident API 入口」），decision 入口只寫
  `decisions/`。

- **Phase C — 聚焦敘事**：`agent/router_agent.py::narrate_for_focus()`，
  拿 Phase B 所有「真的觸發」的項目（含各自的政府版理由 `aiText` 跟民眾版
  訊息 `publicMessage`），加上呼叫端這次問的「關注地點」（可能沒有），
  同一次 LLM 呼叫產生**兩段完全獨立的文字**（`Narrative` dataclass：
  `citizen_text`／`government_text`），不是一段文字換個語氣講兩次：
  - `citizen_text`：口語化，寫給一般市民，不出現 SOP 條號/門檻數字/內部
    調度細節。
  - `government_text`：專業精簡，可引用 SOP 條號跟數據門檻，寫給交控中心
    指揮官。
  - 有給關注地點：兩段文字都先講這個地點本身（沒觸發就講狀況正常），其他
    地方有觸發的話會順帶提醒——這就是使用者要的「A 站順暢，但避免前往
    B 站」，政府/市民版都適用同一個聚焦邏輯。
  - 沒給關注地點：對整體狀況各做一段總結。
  - 完全沒有任何觸發：兩段都用一句話說明目前一切正常/無需處置。
  - **2026-08-01 修正**：這裡原本只生成過市民版（`_NARRATIVE_SYSTEM_PROMPT`
    寫死不能出現 SOP 條號），政府版的融合敘事從沒被寫出來過——`decisions[]`
    陣列裡逐項的 `aiText`/`publicMessage` 兩版都有，但融合成一段話的敘事
    只有市民版這一份，是使用者發現後才補上的落差，不是新加的功能。市民版
    的用字風格也一併重寫：原本讀起來像拿掉 SOP 用語的公文，不是市民真的
    會想看的口吻，prompt 現在明確要求口語、禁止「請」「敬請」「本系統」
    這類公文詞。
  快取在 `decisions/{scenarioAt}/_summary/{locationId 或 "_global"}.json`
  ——每個不同的關注焦點各自快取一份，但都共用同一份 Phase A/B 結果，所以
  第二個問不同焦點的呼叫只需要付 Phase C 這一次輕量呼叫的成本。

## Incident API 入口（`mode: "incident"`，`decision_routing.run_incident_flow`）

`POST /api/incidents` 建立事件後，worker 以 `mode: "incident"` + 該事件的
`eventId` 被呼叫——**只處理這一個事件**，不做城市 sweep：

- 對這個事件評估它的 SOP 判斷：§2 accident（`decide_accident`）、§5
  signal_failure（`decide_signal_failure`）都會跑（同一個事件可能兩條都觸發，
  也可能都不觸發）；如果它的 affected_segment 是 crowd 資料裡的站點，§3
  mrt_diversion 也會評估（例如 `TPE_2026_EVT_002` → `BS_MRT_BL17`）。
- 每個「真的觸發」的判斷：
  - 寫入 `incidents/{date}/{eventId}/decisions/{scenarioAt}/{kind}.json`
    ——放在 incident 自己的資料夾（沿用 `incidents/{date}/{eventId}.json` 的
    date-first 結構），**不碰 `decisions/` keyspace**。
  - 產生**交控中心建議書**（`report_builder.py`）寫到
    `emergency-reports/{date}/{eventId}/report-v1.json`——`GET
    /api/incidents/{eventId}/report` 就是直接從 S3 讀這個 key（`date` 由
    事件的 `occurred_at` 決定）。

跟 decision 入口完全 disjoint：decision 入口只寫 `decisions/`、只回一般決策；
incident 入口只寫 `incidents/` + `emergency-reports/`。界線由 worker 收到的
`mode`（哪個 API 打的）決定——不是 SOP 種類，也不是 event_id 有沒有值。

## 誰會觸發它、怎麼觸發

- 一律透過 [`worker_invoke.invoke_async()`](../worker_invoke.py) 非同步呼叫，
  fire-and-forget，呼叫端不等結果（部署在 AWS 時是真的 `boto3` Lambda
  `Invoke(InvocationType="Event")`；本機開發時是背景 daemon thread）。
- **由打進來的 API 決定 `mode`**，worker 依 `mode` 決定算什麼、寫到哪
  （decision vs incident 的界線就在這裡，不是 SOP 種類）：
  1. **`GET /api/decisions` cache miss**（[`decision/handler.py`](../decision/handler.py)）——
     送 `{"mode": "decision", "scenarioAt", "locationId"?}`。跑城市級 sweep
     （Phase A/B/C），只算一般決策、只寫 `decisions/`。`locationId` 是**選填**：
     帶了就代表「這次的聚焦敘事要針對這個地點」，不帶就是要全域摘要。
  2. **`POST /api/incidents` 建立事件後**（[`incident/handler.py`](../incident/handler.py)）——
     送 `{"mode": "incident", "scenarioAt", "eventId"}`。只處理這一個事件：
     算它的 SOP 判斷、寫 `incidents/{date}/{eventId}/decisions/...` 跟
     `emergency-reports/`（見上面「Incident API 入口」）。best-effort 預熱，
     失敗不影響正確性（report 查詢頂多還是 202 processing）。
- `automation.tf` 的 `rate(5 minutes)` EventBridge 排程
  （`{"source": "eventbridge", "mode": "scheduled"}`）維持原本的 no-op，
  沒有因為這次改版而變動——這個 demo 全部跑在呼叫端帶入的模擬時鐘
  `scenarioAt` 上，不是真實時間，週期性排程沒有明確答案該去掃哪個
  `scenarioAt`，沒有硬猜一個語意出來。

## 效能優化（2026-08-01，針對命題「60 秒內完成路網重規劃」門檻）

- **Phase B / incident flow 內部並行化**（`decision_routing.py`）：
  `_ensure_decisions`（decision 入口的 cache-miss 計算）跟
  `run_incident_flow`（incident 入口最多 3 項 SOP 檢查）原本是逐項序列呼叫
  LLM，改成用 `ThreadPoolExecutor` 並行送出——每一項本來就是獨立的 LLM
  call，彼此沒有共享可變狀態，天生適合並行。效果：N 個同時觸發項的總耗時
  從「N 次序列呼叫的總和」（例如 6 項各 5-20 秒可能逼近甚至超過 60 秒）
  收斂到「約等於最慢那一項單次呼叫的時間」。
  - **唯一的坑**：`psycopg` 連線不是 thread-safe，`decide_dome_dispersal`
    需要的 `db.fetch_crowd_history()` 查詢一定要在丟進並行區塊**之前**先序列
    查完（`_ensure_decisions` 裡的 `dome_history` 預先撈好、當參數傳進並行
    函式，並行函式本身完全不碰 `conn`）。`run_incident_flow` 的三項檢查則
    完全不需要 `conn`，可以直接並行。
  - Phase A（2026-08-02 起已經不是 LLM call，純 Python 決定論計算）不受影響；
    Phase C（narrative）本來就只有一次 LLM call，也沒有並行化的必要——不過
    2026-08-02 另外把 Phase C 拆成 citizen/government 兩個獨立呼叫平行送出
    （government 內容量比 citizen 重很多，拆開後 wall-clock 收斂到較重那份
    的時間，不是兩份加總），細節見 `agent/router_agent.py::narrate_for_focus`。

（原本這裡還有一項「`GET /api/city-state` 輪詢時機會性預熱 decision
cache」——2026-08-01 撤掉了：確認前端是同時、幾乎同一瞬間打
city-state 跟 decision，不是先打 city-state、隔一段時間才切去 AI 決策分頁，
所以「city-state 提早幫 decision 暖機」這個前提不成立，預熱永遠追不上
幾乎同時到達的 decision 請求，純粹多一次無效的 worker 呼叫，已從
`city_state/handler.py` 移除。）

## 15 分鐘快取時槽（`api_common.decision_snapshot_at`）——**只用於 decision mode**

`decision/handler.py` 跟這支 worker 的 handler 在 **`mode: "decision"`** 時，
都會先把收到的 `scenarioAt` 用 `api_common.decision_snapshot_at()` 無條件捨去
到 15 分鐘整（例如 `22:07` 會被捨去成 `22:00`），才拿去查/存快取。**`mode:
"incident"` 完全不套用這個捨去**——用呼叫端傳來的精確 `scenarioAt`（見下面
「收到 reactive 請求」步驟 1 的說明）：

- **這裡（decision 的快取時槽）**：決定「這次查詢/計算要用哪一把 S3 快取
  key」，目的是讓同一個 15 分鐘視窗內、時間戳不完全一樣的多次查詢（例如
  前端每幾秒 poll 一次）都能共用同一份已經算好的結果，不用每次都重新觸發
  整套三階段流程。`decision/handler.py` 的回應會多帶 `resolvedScenarioAt`
  （實際用的時槽）跟 `ageMinutes`（原始查詢時間跟這個時槽差多少分鐘），讓
  呼叫端知道自己拿到的結果是不是完全對得上自己問的那個確切時間點。
- **incident 為什麼不能捨去**（2026-08-01 修過的 bug）：`db.fetch_active_incidents`
  是用 `occurred_at <= scenario_at` 過濾的。如果把 `scenario_at` 無條件捨去
  到 15 分鐘整，可能把它捨去到早於這個事件自己的 `occurred_at`（例如事件
  `22:10` 建立、被捨去成 `22:00` 查詢），導致 `run_incident_flow` 連這個
  事件自己都查不到，安靜地回傳「沒有任何觸發」——而且因為
  `worker_invoke.py` 的背景呼叫是 best-effort、例外會被吞掉，這個失敗不會
  在任何地方報錯，表面上跟「正常但沒觸發」無法區分。用 local server 實測
  注入事件時抓到這個問題：`incidents/`、`emergency-reports/` 都遲遲不出現
  任何 key。修法是 incident mode 用 `parse_scenario_at()` 解析後的原始精確
  時間，完全不經過 `decision_snapshot_at()`。

（原本這裡還有一段「Phase A 的『前一筆快照』」，說明 `_fetch_city_data` 額外
撈前一筆路段/站點資料給 router 看趨勢——2026-08-02 拿掉了：`db.
fetch_previous_traffic_timestamp`/`fetch_previous_crowd_timestamp` 這兩次
額外查詢連同「前一筆快照」資料本身，是專門為了餵給已經拿掉的 LLM router
用的，Phase A 換成決定論計算後沒有任何東西再讀這份資料，所以連同撈取一起
移除，省下每次 sweep 兩次不必要的 DB 查詢。）

## 收到 reactive 請求（`{mode, scenarioAt, locationId? | eventId?}`）後做什麼

worker handler 先看 `mode` 決定走哪條路（預設 `decision`）：

1. 解析 `scenarioAt`；缺這個欄位回 `400`。`mode: "incident"` 時 `eventId`
   必填（缺了就回 `400`）。**只有 `mode: "decision"`** 才會呼叫
   `decision_snapshot_at()` 把收到的 `scenarioAt` 捨去到 15 分鐘時槽——不假設
   呼叫端已經捨去過，確保不管誰觸發、傳的是不是精確時間，最後寫進
   `decisions/` 的 key 都是同一把。`mode: "incident"` 用的是解析後的原始
   精確時間，不捨去（見上面「15 分鐘快取時槽」一節的說明，捨去會讓事件查
   不到自己）。
2. `db.connect()` 接 RDS；連不上回 `503`。
3. **`mode: "decision"`**（`run_worker_phases`）：一次性撈出全市資料
   （`_fetch_city_data`：目前+前一筆的全部路段流量、目前+前一筆的全部站點
   人流、目前所有 active incidents、完整路網拓撲），
   Phase A（`_ensure_city_sweep`）→ Phase B（`_ensure_decisions`）→
   Phase C（`_ensure_narrative`，只針對這次呼叫問的 `locationId`）。只寫
   `decisions/`，不產生建議書。
4. **`mode: "incident"`**（`run_incident_flow`）：只處理指定的 `eventId`，
   算它的 §2/§3/§5 判斷、寫 `incidents/{date}/{eventId}/decisions/...` +
   `emergency-reports/`（見「Incident API 入口」）。不做城市 sweep。
5. `conn.commit()`、`conn.close()`。
6. 回傳 `{"status": "ready", "mode", ...}`——呼叫端本來就是 fire-and-forget，
   這個回傳值目前沒有人讀，純粹方便本機測試直接呼叫這支 handler 時看結果。
   `scenarioAt` 是原始收到的字串；`resolvedScenarioAt`（捨去到 15 分鐘時槽
   之後、實際拿去查/存快取用的值）**只出現在 `mode: "decision"` 的回應**，
   `mode: "incident"` 沒有這個欄位——沒有捨去這回事，`scenarioAt` 就是
   `run_incident_flow` 實際用的精確時間。

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
  "citizenText": "一段口語化融合文字，聚焦 focus（如果有）但仍帶到其他地方，給市民看",
  "governmentText": "一段專業融合文字，聚焦 focus（如果有）但仍帶到其他地方，給指揮官看",
  "decisions": [
    {"decisionId", "sopSectionId", "kind", "locationId", "eventId",
     "summary": {"aiText", "sopRefs"}, "recommendedActions", "estimatedRecovery",
     "reroute", "publicMessage"}
  ]
}
```

未命中時 `202` + 觸發 worker，`retryAfterSeconds` 沿用舊行為。

**`citizenText`／`governmentText` 是兩個完全獨立的頂層欄位，不是包在一個
`summary`/`situationSummary` 物件裡、也不是同一段話換語氣**（2026-08-01
修正——舊版只有單一 `situationSummary` 欄位，而且內容其實只有市民版，
政府版的融合敘事從沒被生成過）。

**`decisions[]` 不受 `locationId` 影響，永遠是全市目前所有真的觸發中的**一般
**決策**（Phase B 的完整結果），不管有沒有帶 `locationId`、帶了哪個，內容都一樣**
——只有 `citizenText`/`governmentText` 才會因為 `locationId` 不同而變。這批是
一般決策（congestion/mrt/dome/multilingual）而已：incident 的 §2/§5 事件回應
**不會**出現在這裡（那是 incident 入口的產物，經
`GET /api/incidents/{eventId}/report` 從 S3 拿）。這是刻意的設計選擇：
`decisions[]` 給前端結構化的「全市當下發生了什麼」完整資料（例如在地圖上
標出每個觸發點），`citizenText`/`governmentText` 給的是「幫你把這些濃縮成
一段話、並聚焦在你關心的地方」的文字，各自對應一種讀者。代價是觸發項目
一多，單次回應就會變大；如果之後要改成 `decisions[]` 也跟著 `locationId`
過濾/裁切，這是 `decision/handler.py::handler()` 裡組 response 的地方要改，
`fetch_cached_view` 本身已經回傳完整的 pairs，過不過濾是 handler 這層的
決定，不用動 `decision_routing.py`。

**這是對 `data/api.md` §4 目前文件內容的實質變更**（`locationId` 從必填變
選填、回應從單一 `aiDecision` 變成 `decisions[]` 陣列 + `citizenText` +
`governmentText`）——我沒有自己去改那份文件，會另外把確切要改的段落告訴
使用者。

## 目前不做的事（刻意，不是漏做）

- 排程觸發（`source=="eventbridge"`）不會主動預先掃任何 `scenarioAt`
  ——見上面「怎麼觸發」的說明，這點沒有因為這次改版而改變。
- 算完決策、寫完建議書之後，**不會**自動組多語簡訊、也不會自動呼叫
  `POST /api/publication` 發布——那條自動化路徑還沒做。
