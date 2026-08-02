# 需求文件

## 簡介

AI City Commander 是一套 AI 驅動的城市交通管理指揮中心系統。系統整合即時車流與人流數據，根據七條標準作業程序（SOP）進行智慧決策，並透過地圖視覺化介面呈現交通態勢、警示與建議處置方案。系統採前後端分離架構，前端以 React 19 + Mapbox GL 呈現互動地圖與圖表，後端以 AWS Lambda 微服務架構執行三層式 AI 決策（事實準備 → LLM 判斷 → 敘事輸出），並以 S3 快取避免重複呼叫 LLM。

## 詞彙表

- **System**：AI City Commander 整體系統
- **Frontend**：React 19 + TypeScript 6 + Vite 6 前端應用程式
- **Backend**：Python 3.12 AWS Lambda 微服務後端
- **Decision_Engine**：後端三層決策引擎（facts → decision → narrative）
- **Rule_Engine**：前端 `src/engine/` 的確定性 SOP 規則引擎（同步鏡像後端 `rules/`）
- **LLM_Client**：可替換的大型語言模型呼叫介面（支援 Bedrock / Anthropic / OmniRoute）
- **S3_Cache**：以 S3 為基礎的決策快取層，按 scenario_at + location_id 為鍵
- **SOP**：標準作業程序，共七條情境規則
- **scenario_at**：模擬時鐘的 ISO 8601 時間戳記，代表當前模擬時刻
- **Fallback**：當 LLM 不可用或呼叫失敗時，退回確定性規則引擎的備援機制
- **Narrator**：敘事層，將已知決策結果轉為白話文摘要
- **Infrastructure**：Terraform 1.10+ 管理的 AWS 基礎設施（VPC、Aurora、API Gateway、Lambda、S3、CloudFront、EventBridge、SNS）

## 需求

### 需求 1：即時交通數據擷取與展示

**使用者故事：** 身為交通指揮中心操作員，我希望系統能即時展示城市車流與人流數據，以便掌握整體交通態勢。

#### 驗收條件

1. WHEN Frontend 以 scenario_at 參數發起定時輪詢，THE Backend SHALL 回傳該模擬時刻以前（含）的車流快照與人流快照數據
2. THE Frontend SHALL 在 Mapbox GL 地圖上以視覺化圖層呈現各路段飽和度與各站點人流密度
3. WHILE 系統處於 demo 資料模式，THE Frontend SHALL 從 public/data/ 靜態資料集載入道路網路、車流、人流與事件資料，不依賴後端 API
4. WHILE 系統處於 api 資料模式，THE Frontend SHALL 從後端 API 取得即時車流與人流數據
5. THE Frontend SHALL 支援模擬時鐘的播放、暫停與速度調整功能

### 需求 2：SOP 第1條 — 交通擁塞分級判斷

**使用者故事：** 身為交通指揮中心操作員，我希望系統能自動依據車流飽和度進行擁塞分級，以便即時掌握各路段壅塞程度並啟動對應處置。

#### 驗收條件

1. WHEN 定時輪詢觸發且路段飽和度數據更新，THE Decision_Engine SHALL 對每個追蹤路段呼叫 decide_congestion 進行擁塞分級判斷
2. THE Decision_Engine SHALL 將路段飽和度原始數值作為事實提供給 LLM_Client，由 LLM_Client 依據 SOP 第1條全文決定分級結果（Normal / B / A）與處置動作
3. IF LLM_Client 不可用或呼叫失敗，THEN THE Decision_Engine SHALL 退回 rules/congestion_tier 確定性函式以門檻比對方式產出分級結果，並標記 source 為 fallback
4. THE S3_Cache SHALL 以 segment_id 與 scenario_at 為鍵快取擁塞分級結果，同一模擬時刻重複輪詢不重新呼叫 LLM_Client

### 需求 3：SOP 第2條 — 事故路障疏散路徑選擇

**使用者故事：** 身為交通指揮中心操作員，我希望系統能在事故發生時自動選出最佳疏散路徑，以便迅速引導車流避開事故路段。

#### 驗收條件

1. WHEN 事件注入後觸發評估，THE Decision_Engine SHALL 從路網拓撲資料組出候選替代路線清單，每條路線包含 capacity_vph、is_direct_intersection、is_upstream 與 current_saturation 等結構性事實
2. THE Decision_Engine SHALL 將候選路線清單與事故資訊作為事實提供給 LLM_Client，由 LLM_Client 依據 SOP 第2條全文決定是否觸發、選出主疏散路徑與次要路徑
3. IF LLM_Client 不可用或呼叫失敗，THEN THE Decision_Engine SHALL 退回 rules/accident_response 確定性函式選擇疏散路徑，並標記 source 為 fallback
4. THE S3_Cache SHALL 以 event_id、scenario_at 與 alert_kind 為鍵快取事故疏散決策結果
5. THE Decision_Engine SHALL 在 facts 組裝時正確處理未對應路口名稱（如正氣橋），保留陣列等長並以 None 填充未對應位置，避免索引位移

### 需求 4：SOP 第3條 — 捷運站分流判斷

**使用者故事：** 身為交通指揮中心操作員，我希望系統能自動偵測捷運站人潮異常並啟動分流建議，以便預防旅客壅塞。

#### 驗收條件

1. WHEN 定時輪詢觸發且 BS_MRT_BL17 站點人流數據更新，THE Decision_Engine SHALL 呼叫 decide_mrt_diversion 進行捷運分流判斷
2. THE Decision_Engine SHALL 將站點人流數、成長率等原始數值作為事實提供給 LLM_Client，由 LLM_Client 依據 SOP 第3條全文決定是否觸發分流
3. IF LLM_Client 不可用或呼叫失敗，THEN THE Decision_Engine SHALL 退回 rules/mrt_diversion 確定性函式進行判斷，並標記 source 為 fallback
4. THE S3_Cache SHALL 以 station_id、scenario_at 與 decision_kind 為鍵快取捷運分流判斷結果

### 需求 5：SOP 第4條 — 大巨蛋散場啟動判斷

**使用者故事：** 身為交通指揮中心操作員，我希望系統能偵測大巨蛋散場跡象並自動啟動散場疏導建議，以便提前部署交通管制。

#### 驗收條件

1. WHEN 定時輪詢觸發且 BS_TPE_DOME 站點歷史序列與當前快照更新，THE Decision_Engine SHALL 呼叫 decide_dome_dispersal 進行散場判斷
2. THE Decision_Engine SHALL 將歷史峰值人流數與當前成長率作為事實提供給 LLM_Client，由 LLM_Client 依據 SOP 第4條全文決定是否觸發散場啟動
3. IF LLM_Client 不可用或呼叫失敗，THEN THE Decision_Engine SHALL 退回 rules/dome_dispersal 確定性函式進行判斷，並標記 source 為 fallback
4. THE S3_Cache SHALL 以 station_id、scenario_at 與 decision_kind 為鍵快取散場判斷結果

### 需求 6：SOP 第5條 — 號誌故障應變判斷

**使用者故事：** 身為交通指揮中心操作員，我希望系統能自動辨識號誌故障事件並啟動應變程序，以便即時派遣支援。

#### 驗收條件

1. WHEN 事件注入後觸發評估，THE Decision_Engine SHALL 對每個事件同時且獨立呼叫 decide_signal_failure 進行號誌故障檢查
2. THE Decision_Engine SHALL 將事件的 type 與 description 文字作為原始事實提供給 LLM_Client，由 LLM_Client 依據 SOP 第5條全文判斷是否為號誌故障事件
3. IF LLM_Client 不可用或呼叫失敗，THEN THE Decision_Engine SHALL 退回 rules/signal_failure 確定性函式進行判斷，並標記 source 為 fallback
4. THE S3_Cache SHALL 以 event_id、scenario_at 與 alert_kind（signal_failure）為鍵快取號誌故障判斷結果，與事故疏散（accident）快取互不覆蓋

### 需求 7：SOP 第6條 — 多語通報判斷與文字產出

**使用者故事：** 身為交通指揮中心操作員，我希望系統能自動偵測高比例漫遊用戶區域並產出多語通報文字，以便及時通知外國旅客。

#### 驗收條件

1. WHEN 定時輪詢觸發且各站點漫遊用戶比例數據更新，THE Decision_Engine SHALL 以所有站點為一批次呼叫 decide_multilingual 進行多語通報判斷
2. THE Decision_Engine SHALL 將各站點的 roaming_pct 原始值作為事實提供給 LLM_Client，由 LLM_Client 依據 SOP 第6條全文決定哪些站點達到通報門檻
3. WHEN 多語通報觸發，THE Narrator SHALL 以確定性模板方式產出中文、英文、日文、韓文四種語言的 CMS 與簡訊通報文字，不使用 LLM_Client 翻譯
4. IF LLM_Client 不可用或呼叫失敗，THEN THE Decision_Engine SHALL 退回 rules/multilingual_check 確定性函式進行判斷，並標記 source 為 fallback
5. THE S3_Cache SHALL 以 scenario_at 與 _ALL_STATIONS_ 為鍵批次快取多語通報判斷結果

### 需求 8：SOP 第7條 — 預計恢復時間 ETE 計算

**使用者故事：** 身為交通指揮中心操作員，我希望系統能自動計算事故預計恢復時間，以便提供明確的疏導期程預估。

#### 驗收條件

1. THE Decision_Engine SHALL 以 rules/ete 確定性公式計算 ETE 值（base_clearance + max(0, (飽和度 - 0.5) * 60)），不經過 LLM_Client 判斷
2. WHEN 事故疏散判斷觸發，THE Decision_Engine SHALL 將 ETE 計算結果作為既定事實提供給 decide_accident 或 summarize 函式引用

### 需求 9：三條觸發路徑整合

**使用者故事：** 身為交通指揮中心操作員，我希望系統支援定時輪詢、事件注入與對話三種觸發方式，以便涵蓋所有交通管理情境。

#### 驗收條件

1. WHEN Frontend 定時輪詢，THE Backend SHALL 透過 GET /api/city-state 端點回傳全部路段擁塞判斷、站點人流判斷與多語通報判斷結果
2. WHEN Frontend 注入事件，THE Backend SHALL 透過 POST /api/incidents 端點建立事件記錄，並透過 POST /api/incidents/{eventId}/evaluate 端點觸發事故疏散與號誌故障雙重判斷
3. WHEN 使用者發起對話，THE Backend SHALL 透過 POST /api/chat 端點以 LLM_Client 搭配完整 SOP 七條全文回答自由文字問題
4. WHEN GET /api/city-state 輪詢執行，THE Backend SHALL 對當前所有 active 事件自動執行事故疏散與號誌故障雙重判斷，不需另外手動呼叫 evaluate

### 需求 10：決策快取機制

**使用者故事：** 身為系統管理員，我希望同一模擬時刻的判斷結果能被快取，以便避免重複呼叫 LLM 造成延遲與費用。

#### 驗收條件

1. THE S3_Cache SHALL 以 scenario_at 與 location_id 為複合鍵儲存決策結果至 S3 物件儲存
2. WHEN 同一組 scenario_at 與 location_id 的決策已存在於 S3_Cache，THE Decision_Engine SHALL 直接回傳快取結果，不重新呼叫 LLM_Client
3. THE System SHALL 提供 clear_cache.py 工具程式，支援依 scenario_at、event_id 或全部清除快取物件
4. THE S3_Cache SHALL 將 scenario_at 中的冒號字元替換為連字號作為 S3 物件鍵

### 需求 11：政府與民眾雙受眾輸出區隔

**使用者故事：** 身為系統設計者，我希望決策輸出區分政府版（reasoning）與民眾版（publicMessage），以便保護內部處置細節不外洩。

#### 驗收條件

1. THE Decision_Engine SHALL 在同一次 LLM_Client 呼叫中同時產出 reasoning（政府版：含 SOP 條號、門檻數字、內部處置細節）與 publicMessage（民眾版：僅含行動建議）
2. THE Frontend SHALL 在民眾模式僅顯示 publicMessage 欄位，不得顯示、截斷或精簡 reasoning 欄位內容
3. WHILE 決策結果為未觸發（triggered = false），THE Decision_Engine SHALL 將 publicMessage 設為空字串
4. THE Infrastructure SHALL 以獨立的 public S3 bucket 與 internal S3 bucket 區隔民眾可存取內容與政府內部內容

### 需求 12：前端視覺化與互動介面

**使用者故事：** 身為交通指揮中心操作員，我希望透過互動地圖與圖表介面瀏覽交通態勢與決策結果，以便快速理解並回應交通狀況。

#### 驗收條件

1. THE Frontend SHALL 以 Mapbox GL 與 deck.gl 9 呈現道路網路、路段擁塞程度、站點人流密度與事故位置圖層
2. THE Frontend SHALL 以 Recharts 3 呈現車流與人流時序趨勢圖表
3. WHEN SOP 判斷觸發警示，THE Frontend SHALL 在介面上自動彈出分析摘要面板，顯示觸發的 SOP 條號、判斷結果與建議處置
4. THE Frontend SHALL 以 Zustand 5 管理全域應用狀態，包含模擬時鐘、當前場景、警示清單與決策結果

### 需求 13：基礎設施部署與環境管理

**使用者故事：** 身為 DevOps 工程師，我希望系統基礎設施以 Terraform 宣告式管理，以便可重現地部署整套環境。

#### 驗收條件

1. THE Infrastructure SHALL 以 Terraform 1.10+ 管理所有 AWS 資源，包含 VPC、Aurora Serverless v2、API Gateway、Lambda 容器、S3、CloudFront、EventBridge 與 SNS
2. THE Infrastructure SHALL 使用 S3 作為 Terraform remote state 儲存，並以 bootstrap 模組獨立建立 state bucket 避免循環依賴
3. THE Infrastructure SHALL 以 database-seed Lambda 在部署時自動執行 schema 建立與 demo 資料載入
4. THE Infrastructure SHALL 為 Lambda 函式設定 IAM Role，包含 Bedrock InvokeModel 權限，使用 AWS 標準憑證鏈認證

### 需求 14：LLM 呼叫介面與供應商切換

**使用者故事：** 身為系統管理員，我希望 LLM 供應商可依環境變數切換，以便在不同部署環境使用最適合的 AI 服務。

#### 驗收條件

1. THE LLM_Client SHALL 依下列優先順序選擇 LLM 供應商：AgentCore（若已設定 BEDROCK_AGENTCORE_RUNTIME_ARN）、Bedrock（若已設定 BEDROCK_MODEL_ID）、Anthropic API（若已設定 ANTHROPIC_API_KEY）、OmniRoute（若已設定 OMNIROUTE_BASE_URL）
2. IF 所有 LLM 供應商皆未設定，THEN THE System SHALL 全部退回 rules/ 確定性函式與 templates.py 罐頭文字，API 端點維持正常運作不回傳錯誤
3. THE LLM_Client SHALL 對 Bedrock 供應商使用 IAM Role 認證（boto3 converse API），不儲存或讀取任何 API 金鑰

### 需求 15：敘事層輸出

**使用者故事：** 身為交通指揮中心操作員，我希望決策結果能被轉化為易讀的白話文摘要，以便快速理解建議內容。

#### 驗收條件

1. WHEN 決策結果產出後，THE Narrator SHALL 透過 summarize 函式將已知判斷結果轉為白話文敘述，本身不做任何新的判斷
2. IF LLM_Client 不可用，THEN THE Narrator SHALL 退回 templates.py 罐頭文字作為敘事輸出
3. THE Narrator SHALL 透過 generate_multilingual 函式以確定性字串模板產出四語通報文字，不使用 LLM_Client

### 需求 16：事件雙重 SOP 檢查機制

**使用者故事：** 身為交通指揮中心操作員，我希望每個事件都同時檢查事故疏散與號誌故障兩條 SOP，以免因預先猜測事件類型而遺漏邊際情況。

#### 驗收條件

1. WHEN 事件評估觸發，THE Decision_Engine SHALL 對同一事件同時且獨立執行 decide_accident（SOP 第2條）與 decide_signal_failure（SOP 第5條）兩項檢查
2. THE Decision_Engine SHALL 以 alert_kind 欄位區隔同一事件的兩種 SOP 檢查快取，確保互不覆蓋
3. THE Backend SHALL 以 aiDecisions 陣列格式回傳同一事件的多項 SOP 檢查結果，每項各自標示 triggered 狀態
