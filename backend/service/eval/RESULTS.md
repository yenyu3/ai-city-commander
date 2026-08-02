# Eval 結果

執行環境：真實 Bedrock LLM（`BEDROCK_MODEL_ID=us.anthropic.claude-sonnet-4-6`, `AWS_REGION=us-west-2`），本地 Postgres + 真實 demo 資料集（`city_traffic_flow.csv`/`signaling_crowd_density.csv`/`live_incidents.json`，涵蓋 2026-05-20 09:00–15:15 共 15 個時間點）。腳本都在 `backend/service/eval/`，用 `python3 -m eval.<script>` 執行。

## LLM vs 規則引擎一致率（`llm_vs_rules_consistency.py`）

每個 SOP 條文各自的觸發判斷，LLM 路徑（`agent/facts.py::decide_*()`）跟 `rules/*.py` 決定論版本（SOP 門檻/正規表達式的忠實移植）逐一比對，看 LLM 是否跟明文規則一致。N 是樣本數，Agree 是一致率，TP/TN 是雙方都同意觸發／不觸發，FP 是 LLM 判觸發但規則判沒有，FN 是反過來。

| SOP 條文 | N | 一致率 | TP | TN | FP | FN |
|---|---|---|---|---|---|---|
| §1 交通擁塞級別判定 | 164 | 1.000 | 22 | 142 | 0 | 0 |
| §3 捷運分流 | 15 | 0.933 | 11 | 3 | 1 | 0 |
| §4 大巨蛋散場 | 15 | 1.000 | 7 | 8 | 0 | 0 |
| §5 號誌故障應變 | 6 | 1.000 | 4 | 2 | 0 | 0 |
| §6 多語化通報 | 105 | 1.000 | 22 | 83 | 0 | 0 |

## 疏散路徑選擇正確率（`evacuation_route_accuracy.py`）

15 個真實路段各合成一個 Closed+Critical 事故，比對 `decide_accident()`（SOP §2）選出的主／次疏散路徑，跟 `rules/accident_response.py` 決定論版本是否一致。

| 指標 | 結果 |
|---|---|
| 觸發判定一致 | 15/15（100.0%） |
| 主疏散路徑完全一致 | 15/15（100.0%） |
| 次要疏散路徑完全一致 | 14/15（93.3%） |

僅 `RD_TPE_004` 一筆不一致：LLM 判斷無次要疏散路徑，規則引擎判斷應為 `RD_TPE_006`。

## Incident 響應時間（`incident_response_latency.py`）

`POST /api/incidents` 觸發的單一事件判斷（`run_incident_flow`：SOP 檢查 → 交控中心建議書 → 公告發布）實際耗時，對照命題「60 秒內完成路網重規劃」。用 `data/live_incidents.json` 三個真實種子事件，涵蓋三條不同的事件觸發路徑。

| Event ID | 觸發的 SOP | 耗時 |
|---|---|---|
| TPE_2026_ACC_001 | §2 車禍/路障應變 | 42.44s |
| TPE_2026_EVT_002 | §3 捷運分流 | 32.17s |
| TPE_2026_EVT_003 | §5 號誌故障應變 | 35.18s |

p50 35.18s，p95 41.72s，全部在 60 秒預算內（0/3 超過）。

## 端到端延遲（`decision_latency.py`）

`GET /api/decisions` 城市全域 sweep（`run_worker_phases`，冷快取）的實際運算時間，對照命題「60 秒內完成路網重規劃」，涵蓋 15 個時間點各一次。

| 指標 | 數值 |
|---|---|
| Min | 17.45s |
| p50 | 56.95s |
| Max | 69.99s |
| 超過 60s 預算 | 6/15 |

尖峰時段（同時多個路段/站點觸發）仍有部分超過預算，瓶頸在單次 LLM 判斷/敘述生成的時間，不是候選數量或並行度。
