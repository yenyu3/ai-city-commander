# Implementation Plan: AI City Commander 全系統實作

## Overview

基於現有專案結構，本實作計畫涵蓋三層式決策引擎的完善、前端視覺化與狀態管理、S3 快取層、七條 SOP 情境的端到端整合，以及 14 條正確性屬性的 property-based testing。後端使用 Python 3.12 + pytest + Hypothesis，前端使用 TypeScript 6 + Vitest + fast-check。

## Tasks

- [ ] 1. 後端核心介面與共用模組完善
  - [ ] 1.1 定義 Decision dataclass 與 ReasoningStep 結構
    - 在 `backend/service/agent/` 下建立或更新 `types.py`，定義 `Decision` dataclass（triggered、sop_section_id、result、reasoning、public_message、source、reasoning_steps）
    - 定義 `ReasoningStep` dataclass
    - 確保所有現有 handler 引用統一型別
    - _Requirements: 11.1, 11.3_

  - [ ] 1.2 完善 LLM Client 抽象介面與供應商優先序邏輯
    - 更新 `backend/service/agent/llm_client.py` 中 `get_configured_llm_client()` 函式
    - 實作 AgentCore > Bedrock > Anthropic > OmniRoute > None 優先序
    - Bedrock 供應商使用 boto3 converse API + IAM Role 認證
    - _Requirements: 14.1, 14.2, 14.3_

  - [ ] 1.3 完善 S3 快取層鍵格式與冒號替換
    - 更新 `backend/service/s3_cache.py`，確保 scenario_at 中冒號替換為連字號
    - 實作各 SOP 情境的快取鍵格式（segments、stations、incidents）
    - 實作 get/put/delete 操作與 NoSuchKey 錯誤處理
    - _Requirements: 10.1, 10.2, 10.4_

  - [ ]* 1.4 撰寫 Property 9 屬性測試：S3 鍵冒號替換
    - **Property 9: S3 鍵冒號替換**
    - 使用 Hypothesis 生成隨機 ISO 8601 時間戳記，驗證產出鍵不含冒號
    - **Validates: Requirements 10.4**

  - [ ]* 1.5 撰寫 Property 11 屬性測試：LLM 供應商優先序
    - **Property 11: LLM 供應商優先序**
    - 使用 Hypothesis 生成隨機環境變數子集組合，驗證選擇結果遵循優先序
    - **Validates: Requirements 14.1**

- [ ] 2. 三層決策引擎 — 事實準備層
  - [ ] 2.1 實作 facts.py 擁塞分級事實組裝
    - 在 `backend/service/agent/facts.py` 實作 `build_congestion_facts(segment, snapshot)` 函式
    - 僅組裝原始數值（saturation、vehicle_count、capacity_vph），不含 tier 等判斷欄位
    - _Requirements: 2.1, 2.2_

  - [ ] 2.2 實作 facts.py 事故疏散候選路線組裝
    - 實作 `build_accident_facts(incident, road_network, traffic_snapshots)` 函式
    - 每條候選路線包含 capacity_vph、is_direct_intersection、is_upstream、current_saturation
    - 正確處理未對應路口名稱，保留陣列等長以 None 填充
    - _Requirements: 3.1, 3.2, 3.5_

  - [ ] 2.3 實作 facts.py 捷運分流與大巨蛋散場事實組裝
    - 實作 `build_mrt_diversion_facts(station, crowd_snapshot)` 函式
    - 實作 `build_dome_dispersal_facts(station, historical_snapshots, current_snapshot)` 函式
    - 僅提供原始人流數、成長率、歷史峰值，不含預判結果
    - _Requirements: 4.2, 5.2_

  - [ ] 2.4 實作 facts.py 號誌故障與多語通報事實組裝
    - 實作 `build_signal_failure_facts(incident)` 函式（事件 type + description）
    - 實作 `build_multilingual_facts(stations, crowd_snapshots)` 函式（各站 roaming_pct）
    - _Requirements: 6.2, 7.2_

  - [ ]* 2.5 撰寫 Property 2 屬性測試：事實層不預判
    - **Property 2: 事實層不預判**
    - 使用 Hypothesis 生成隨機飽和度/人流/路網資料，驗證組裝結果不含判斷欄位
    - **Validates: Requirements 2.2, 3.2, 4.2, 5.2, 6.2, 7.2**

  - [ ]* 2.6 撰寫 Property 6 屬性測試：候選路線結構完整性
    - **Property 6: 候選路線結構完整性**
    - 使用 Hypothesis 生成隨機路網拓撲 + 事故位置，驗證必含四欄位且不含預選欄位
    - **Validates: Requirements 3.1, 3.2**

  - [ ]* 2.7 撰寫 Property 7 屬性測試：未對應路口陣列等長
    - **Property 7: 未對應路口陣列等長**
    - 使用 Hypothesis 生成隨機含未對應名稱的路口陣列，驗證產出陣列等長
    - **Validates: Requirements 3.5**

- [ ] 3. 三層決策引擎 — LLM 判斷層與確定性備援
  - [ ] 3.1 完善 decision_agent.py 通用 decide() 函式
    - 更新 `backend/service/agent/decision_agent.py`，確保 decide() 接收 facts dict + SOP 全文
    - 實作 JSON 解析修復邏輯（_parse_json_response、_escape_stray_quotes、raw_decode）
    - 實作 _normalize_sop_section_id 提取純數字
    - LLM 失敗時呼叫對應 rules/ 函式作為 fallback
    - _Requirements: 2.2, 2.3, 3.2, 3.3, 4.2, 4.3, 5.2, 5.3, 6.2, 6.3, 7.2, 7.4_

  - [ ] 3.2 完善 rules/ 七條確定性備援函式
    - 確認 `rules/congestion_tier.py` 門檻邏輯（0.85→B, 0.95→A）
    - 確認 `rules/accident_response.py` 選路邏輯
    - 確認 `rules/mrt_diversion.py`、`rules/dome_dispersal.py` 判斷邏輯
    - 確認 `rules/signal_failure.py` 關鍵字比對邏輯
    - 確認 `rules/multilingual_check.py` roaming_pct 門檻
    - 確認 `rules/ete.py` 確定性公式：`base_clearance(severity) + max(0, (saturation - 0.5) * 60)`
    - _Requirements: 2.3, 3.3, 4.3, 5.3, 6.3, 7.4, 8.1_

  - [ ] 3.3 實作 triggered=false 時 public_message 設為空字串邏輯
    - 在 decide() 或 Decision 建構時，確保未觸發決策的 public_message 為空字串
    - _Requirements: 11.3_

  - [ ]* 3.4 撰寫 Property 3 屬性測試：備援降級一致性
    - **Property 3: 備援降級一致性**
    - 使用 Hypothesis 生成隨機 scope + mock LLM 回傳 None/Exception，驗證 source="fallback" 且結果由 rules/ 計算
    - **Validates: Requirements 2.3, 3.3, 4.3, 5.3, 6.3, 7.4, 14.2, 15.2**

  - [ ]* 3.5 撰寫 Property 8 屬性測試：ETE 公式確定性
    - **Property 8: ETE 公式確定性**
    - 使用 Hypothesis 生成隨機 severity 與 saturation ∈ [0, 1]，驗證計算結果符合公式
    - **Validates: Requirements 8.1**

  - [ ]* 3.6 撰寫 Property 10 屬性測試：未觸發決策無民眾訊息
    - **Property 10: 未觸發決策無民眾訊息**
    - 使用 Hypothesis 生成隨機 Decision(triggered=False)，驗證 public_message 為空字串
    - **Validates: Requirements 11.3**

- [ ] 4. 三層決策引擎 — 敘事層
  - [ ] 4.1 完善 narrator.py summarize 與 generate_multilingual 函式
    - 更新 `backend/service/agent/narrator.py`，確保 summarize() 僅將已知結果轉白話文，不做新判斷
    - 確保 summarize() 不修改原始 Decision 物件的 triggered/sop_section_id/result 欄位
    - 實作 generate_multilingual()：確定性字串模板產出 zh/en/ja/ko 四語文字
    - LLM 不可用時退回 templates.py 罐頭文字
    - _Requirements: 7.3, 15.1, 15.2, 15.3_

  - [ ]* 4.2 撰寫 Property 13 屬性測試：多語輸出確定性
    - **Property 13: 多語輸出確定性**
    - 使用 Hypothesis 生成隨機 messageType + values，驗證輸出恰好 zh/en/ja/ko 四鍵且相同輸入相同輸出
    - **Validates: Requirements 7.3, 15.3**

  - [ ]* 4.3 撰寫 Property 14 屬性測試：敘事層不改判斷
    - **Property 14: 敘事層不改判斷**
    - 使用 Hypothesis 生成隨機 Decision 物件，經 summarize() 後驗證 triggered/sop_section_id/result 不變
    - **Validates: Requirements 15.1**

- [ ] 5. Checkpoint — 決策引擎核心測試通過
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 6. 後端 API 端點 — 定時輪詢路徑
  - [ ] 6.1 實作 city_state handler GET /api/city-state
    - 更新 `backend/service/city_state/handler.py`
    - 接收 scenarioAt 參數，查詢 DB 取得 ≤ scenarioAt 的車流/人流快照
    - 對每路段呼叫 decide_congestion，對指定站點呼叫 mrt_diversion/dome_dispersal
    - 批次呼叫 decide_multilingual
    - 對所有 active 事件自動執行雙重 SOP 判斷
    - 回傳完整 city-state 結構（segments、stations、multilingual、incidents）
    - _Requirements: 1.1, 2.1, 4.1, 5.1, 7.1, 9.1, 9.4_

  - [ ]* 6.2 撰寫 Property 1 屬性測試：時間過濾不變量
    - **Property 1: 時間過濾不變量**
    - 使用 Hypothesis 生成隨機 scenario_at + 快照集合，驗證回傳的 observed_at 皆 ≤ scenario_at
    - **Validates: Requirements 1.1**

  - [ ]* 6.3 撰寫 Property 4 屬性測試：快取冪等性
    - **Property 4: 快取冪等性**
    - 使用 Hypothesis + moto 生成隨機 (location_id, scenario_at)，驗證第二次呼叫不再觸發 LLM
    - **Validates: Requirements 2.4, 10.2**

- [ ] 7. 後端 API 端點 — 事件注入路徑
  - [ ] 7.1 實作 incident handler POST /api/incidents 與 POST /api/incidents/{eventId}/evaluate
    - 更新 `backend/service/incident/handler.py`
    - POST /incidents：建立事件記錄至 DB
    - POST /incidents/{eventId}/evaluate：同時且獨立執行 decide_accident + decide_signal_failure
    - 回傳 aiDecisions 陣列，各自具獨立 triggered 狀態
    - _Requirements: 3.1, 6.1, 9.2, 16.1, 16.3_

  - [ ]* 7.2 撰寫 Property 5 屬性測試：快取鍵隔離
    - **Property 5: 快取鍵隔離**
    - 使用 Hypothesis + moto 生成隨機 event_id + 兩種 alert_kind，驗證 S3 鍵不同且互不覆蓋
    - **Validates: Requirements 3.4, 4.4, 5.4, 6.4, 16.2**

  - [ ]* 7.3 撰寫 Property 12 屬性測試：事件雙重 SOP 檢查
    - **Property 12: 事件雙重 SOP 檢查**
    - 使用 Hypothesis + moto 生成隨機事件類型與描述，驗證回傳 aiDecisions 至少兩元素
    - **Validates: Requirements 6.1, 16.1, 16.3**

- [ ] 8. 後端 API 端點 — 對話路徑
  - [ ] 8.1 實作 chat handler POST /api/chat
    - 更新 `backend/service/chat/handler.py`
    - 接收 message、context.scenarioAt、mode（government/public）
    - 使用 LLM_Client 搭配 SOP 七條全文（sop_sections.py）回答問題
    - 回傳 reply、reasoningSteps、sopRefs
    - _Requirements: 9.3_

- [ ] 9. Checkpoint — 後端 API 端點整合測試通過
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 10. 前端狀態管理與資料服務層
  - [ ] 10.1 完善 Zustand store 狀態模型
    - 更新 `frontend/src/store/` 下的 store 定義
    - 實作 AppState 完整介面（currentTime、isPlaying、playbackSpeed、roadSegments、stations、decisions、alerts）
    - 實作 advanceTime()、setPlaybackSpeed()、togglePlayback() 操作
    - _Requirements: 1.5, 12.4_

  - [ ] 10.2 完善 services/ API 呼叫抽象層
    - 更新 `frontend/src/services/` 下的 apiClient 與 adapters
    - 實作 demo 模式（從 public/data/ 載入靜態資料）與 api 模式（串接後端 API）雙模式切換
    - API 呼叫失敗時以前端 engine/ 規則引擎作為降級路徑
    - _Requirements: 1.3, 1.4_

  - [ ]* 10.3 撰寫前端 store 與 services 單元測試
    - 使用 Vitest 測試播放/暫停/速度調整狀態轉換
    - 測試 demo/api 模式切換邏輯
    - _Requirements: 1.3, 1.4, 1.5_

- [ ] 11. 前端 engine/ 確定性規則鏡像
  - [ ] 11.1 確認前端 engine/ 七條規則與後端 rules/ 同步
    - 檢查 `frontend/src/engine/` 下所有規則檔案（congestionTier、accidentResponse、mrtDiversion、domeDispersal、signalFailure、multilingualCheck、ete）
    - 確保門檻值、計算邏輯與後端完全一致
    - 驗證 ruleEngine.test.ts 使用與後端 test_rules.py 相同黃金案例
    - _Requirements: 1.3, 2.3, 3.3, 4.3, 5.3, 6.3, 7.4, 8.1_

  - [ ]* 11.2 補充前端 engine/ 邊界值測試
    - 使用 Vitest 測試擁塞門檻邊界（0.84→Normal, 0.85→B, 0.95→A）
    - 確認 ETE 計算與後端一致
    - _Requirements: 2.3, 8.1_

- [ ] 12. 前端視覺化元件
  - [ ] 12.1 完善 MapStage 地圖圖層元件
    - 更新 `frontend/src/components/` 下地圖相關元件
    - 以 Mapbox GL + deck.gl 9 呈現道路網路、路段飽和度、站點人流密度、事故位置圖層
    - 圖層資料從 store 取得，自動隨模擬時鐘更新
    - _Requirements: 1.2, 12.1_

  - [ ] 12.2 完善 Charts 時序趨勢圖表元件
    - 以 Recharts 3 呈現車流與人流時序趨勢圖表
    - 資料來源為 store 中的 trafficSnapshots 與 crowdSnapshots
    - _Requirements: 12.2_

  - [ ] 12.3 實作 AlertOverlay 警示彈出面板
    - 實作 SOP 觸發時自動彈出的分析摘要面板
    - 顯示觸發的 SOP 條號、判斷結果與建議處置
    - 區分政府模式（顯示 reasoning）與民眾模式（僅顯示 publicMessage）
    - _Requirements: 11.2, 12.3_

  - [ ] 12.4 完善 ChatFab 對話介面元件
    - 實作政府/民眾雙模式對話介面
    - 串接 POST /api/chat 端點
    - 顯示 reply、reasoningSteps（政府模式）、sopRefs
    - _Requirements: 9.3, 11.2_

- [ ] 13. Checkpoint — 前端元件測試通過
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 14. 基礎設施 Terraform 模組完善
  - [ ] 14.1 完善 Terraform 主要模組資源宣告
    - 確認 `backend/terraform/` 下各 .tf 檔案覆蓋所有必要資源
    - 確認 VPC、Aurora Serverless v2、API Gateway、Lambda 容器、S3（internal + public）、CloudFront、EventBridge、SNS
    - 確認 Lambda IAM Role 包含 Bedrock InvokeModel 權限
    - 確認 bootstrap 模組獨立建立 state bucket
    - _Requirements: 13.1, 13.2, 13.4_

  - [ ] 14.2 確認 database-seed Lambda 自動執行 schema 與 demo 資料載入
    - 確認 `backend/terraform/database/` 下的 seed 機制
    - 確保部署時自動執行 schema 建立（road_segments、stations、traffic_snapshots、crowd_snapshots、incidents、decision_jobs）
    - 確保 demo 資料正確載入
    - _Requirements: 13.3_

  - [ ] 14.3 確認 S3 bucket 區隔（internal vs public）
    - 確認 `backend/terraform/storage.tf` 中 internal bucket（決策快取、政府報告）與 public bucket（民眾公告）分離
    - 確認 public bucket 透過 CloudFront 分發
    - _Requirements: 11.4_

- [ ] 15. 端到端整合驗證
  - [ ] 15.1 撰寫 city-state 端到端整合測試
    - 使用 pytest + moto 模擬完整輪詢流程（DB → facts → decide → cache → response）
    - 驗證回傳結構包含 segments、stations、multilingual、incidents
    - _Requirements: 9.1, 9.4_

  - [ ] 15.2 撰寫事件注入端到端整合測試
    - 使用 pytest + moto 模擬 POST incidents → evaluate → 雙重 SOP 結果
    - 驗證 aiDecisions 陣列包含 accident 與 signal_failure 兩項
    - _Requirements: 9.2, 16.1, 16.3_

  - [ ]* 15.3 撰寫對話端點整合測試
    - 使用 pytest + mock LLM 驗證 SOP 全文傳入 + 回覆格式正確
    - _Requirements: 9.3_

- [ ] 16. Final checkpoint — 全部測試通過
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties (14 properties using Hypothesis)
- Unit tests validate specific examples and edge cases
- 後端測試使用 pytest + Hypothesis + moto（mock S3），不需真實 AWS 憑證
- 前端測試使用 Vitest + fast-check
- Terraform 驗證使用 `terraform plan` 確認資源宣告無衝突
- 現有 `backend/service/tests/` 下已有基礎測試，新增測試應遵循相同風格

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3"] },
    { "id": 1, "tasks": ["1.4", "1.5", "2.1", "2.2", "2.3", "2.4"] },
    { "id": 2, "tasks": ["2.5", "2.6", "2.7", "3.1", "3.2", "3.3"] },
    { "id": 3, "tasks": ["3.4", "3.5", "3.6", "4.1"] },
    { "id": 4, "tasks": ["4.2", "4.3", "6.1", "7.1", "8.1"] },
    { "id": 5, "tasks": ["6.2", "6.3", "7.2", "7.3", "10.1", "10.2", "11.1"] },
    { "id": 6, "tasks": ["10.3", "11.2", "12.1", "12.2", "12.3", "12.4"] },
    { "id": 7, "tasks": ["14.1", "14.2", "14.3"] },
    { "id": 8, "tasks": ["15.1", "15.2", "15.3"] }
  ]
}
```
