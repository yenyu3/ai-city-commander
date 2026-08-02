# Design Document

## Overview

AI City Commander 採用前後端分離架構，前端以 React 19 + Mapbox GL + deck.gl 9 呈現互動地圖與視覺化圖表，後端以 Python 3.12 AWS Lambda 微服務執行三層式 AI 決策引擎。系統核心設計理念為「事實準備 → LLM 判斷 → 敘事輸出」三層分離，搭配 S3 快取與確定性規則備援，確保系統在 LLM 不可用時仍維持服務可用性。

## Architecture

### 系統層級架構

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Frontend (React 19)                          │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐ ┌─────────┐ │
│  │ MapStage │ │  Charts  │ │  Alerts  │ │   Chat    │ │  Store  │ │
│  │(Mapbox+  │ │(Recharts)│ │ Overlay  │ │   Fab     │ │(Zustand)│ │
│  │ deck.gl) │ │          │ │          │ │           │ │         │ │
│  └──────────┘ └──────────┘ └──────────┘ └───────────┘ └─────────┘ │
│                    │              │              │                    │
│              ┌─────┴──────────────┴──────────────┴──────┐           │
│              │       services/ (apiClient + adapters)     │           │
│              └───────────────────┬───────────────────────┘           │
│                                  │                                    │
│              ┌───────────────────┴───────────────────────┐           │
│              │       engine/ (確定性 SOP 規則鏡像)         │           │
│              └───────────────────────────────────────────┘           │
└──────────────────────────────────┬──────────────────────────────────┘
                                   │ HTTP (API Gateway)
┌──────────────────────────────────┼──────────────────────────────────┐
│                         Backend (AWS Lambda)                          │
│                                  │                                    │
│  ┌───────────────────────────────┴────────────────────────────────┐ │
│  │                    API Gateway (REST)                            │ │
│  │  GET /city-state  POST /incidents  POST /chat  POST /agent      │ │
│  └──────┬────────────────┬────────────────┬───────────────────────┘ │
│         │                │                │                          │
│  ┌──────┴────────────────┴────────────────┴───────────────────────┐ │
│  │                    Lambda Handlers                               │ │
│  │  city_state/  incident/  chat/  decision/  publication/ report/ │ │
│  └──────┬────────────────┬────────────────┬───────────────────────┘ │
│         │                │                │                          │
│  ┌──────┴────────────────┴────────────────┴───────────────────────┐ │
│  │              Three-Layer Decision Engine                         │ │
│  │  ┌────────────┐  ┌─────────────────┐  ┌────────────────────┐  │ │
│  │  │ facts.py   │→│ decision_agent.py │→│    narrator.py      │  │ │
│  │  │ (事實準備)  │  │   (LLM 判斷)     │  │   (敘事輸出)        │  │ │
│  │  └────────────┘  └────────┬────────┘  └────────────────────┘  │ │
│  │                           │ fallback                            │ │
│  │                    ┌──────┴──────┐                              │ │
│  │                    │   rules/    │                              │ │
│  │                    │(確定性備援)  │                              │ │
│  │                    └─────────────┘                              │ │
│  └────────────────────────────────────────────────────────────────┘ │
│         │                                        │                   │
│  ┌──────┴──────┐                          ┌──────┴──────┐          │
│  │  Aurora DB  │                          │  S3 Cache   │          │
│  │(操作型資料)  │                          │ (決策快取)   │          │
│  └─────────────┘                          └─────────────┘          │
└─────────────────────────────────────────────────────────────────────┘
                                   │
                            ┌──────┴──────┐
                            │   Bedrock   │
                            │  (LLM API)  │
                            └─────────────┘
```

### 三條觸發路徑

```
① 定時輪詢: Frontend → GET /api/city-state?scenarioAt=... → 全路段擁塞 + 全站點人流 + 多語通報
② 事件注入: Frontend → POST /api/incidents → POST /api/incidents/{id}/evaluate → 事故 + 號誌雙重檢查
③ 對話:     Frontend → POST /api/chat → LLM + SOP 全文回答
```

## Components and Interfaces

### 前端元件

| 元件 | 技術 | 職責 |
|------|------|------|
| `MapStage` | Mapbox GL + deck.gl 9 | 呈現道路網路、路段飽和度、站點人流密度、事故位置圖層 |
| `Charts` | Recharts 3 | 車流與人流時序趨勢圖表 |
| `AlertOverlay` | React | SOP 觸發時自動彈出分析摘要面板 |
| `ChatFab` | React | 對話介面（政府/民眾模式） |
| `appStore` | Zustand 5 | 全域狀態管理（模擬時鐘、場景、警示、決策結果） |
| `engine/` | TypeScript | 確定性 SOP 規則鏡像（同步後端 `rules/`） |
| `services/` | TypeScript | API 呼叫抽象層（apiClient、adapters） |

### 後端元件

| 元件 | 技術 | 職責 |
|------|------|------|
| `agent/facts.py` | Python | 組裝原始事實數據，不做任何判斷 |
| `agent/decision_agent.py` | Python | 通用 decide() 函式：事實 + SOP 全文 → LLM 決定 |
| `agent/narrator.py` | Python | 純敘事層：將已知結果轉白話文 |
| `agent/llm_client.py` | Python | 可替換 LLM 介面（AgentCore/Bedrock/Anthropic/OmniRoute） |
| `agent/sop_sections.py` | Python | SOP 七條全文（活在程式碼中，不在 DB） |
| `rules/` | Python | 確定性 SOP 規則備援（congestion_tier、accident_response、mrt_diversion、dome_dispersal、signal_failure、multilingual_check、ete） |
| `s3_cache.py` | Python + boto3 | S3 決策快取存取層 |
| `db.py` | Python + psycopg | Aurora PostgreSQL 操作型資料存取 |

### 基礎設施元件

| 元件 | 技術 | 職責 |
|------|------|------|
| API Gateway | AWS | REST API 入口 |
| Lambda (容器化) | AWS | 各端點獨立 Lambda 函式 |
| Aurora Serverless v2 | AWS | PostgreSQL 16 操作型資料庫 |
| S3 (internal) | AWS | 決策快取、政府報告 |
| S3 (public) | AWS | 民眾可存取公告 |
| CloudFront | AWS | 前端靜態資產 CDN + 公告分發 |
| EventBridge | AWS | 定時觸發排程 |
| Bedrock | AWS | LLM 推論服務 |

### API 端點

```python
# 觸發路徑 ①：定時輪詢
GET /api/city-state?scenarioAt={ISO8601}
# Response: {
#   segments: [{ segmentId, name, saturation, decision: { tier, actions, triggered, reasoning, publicMessage } }],
#   stations: [{ stationId, name, userCount, growthRate, decisions: { mrt_diversion?, dome_dispersal? } }],
#   multilingual: { triggered, stations: [...], messages: { zh, en, ja, ko } },
#   incidents: [{ eventId, aiDecisions: [{ alertKind, triggered, reasoning, publicMessage }] }]
# }

# 觸發路徑 ②：事件注入
POST /api/incidents
# Body: { context: { scenarioAt }, incident: { type, location, affectedSegment, severity, description, ... } }
# Response: { eventId }

POST /api/incidents/{eventId}/evaluate
# Body: { context: { scenarioAt } }
# Response: { aiDecisions: [{ alertKind, triggered, sopSectionId, result, reasoning, publicMessage }] }

# 觸發路徑 ③：對話
POST /api/chat
# Body: { message, context: { scenarioAt }, mode: "government" | "public" }
# Response: { reply, reasoningSteps?, sopRefs? }

# 低階偵錯介面
POST /api/agent
# Body: { action: "decide"|"summarize"|"answer_what_if"|"generate_multilingual", ...params }
```

### LLM Client 介面

```python
class LLMClient(ABC):
    @abstractmethod
    def complete(self, system: str, prompt: str, *, max_tokens: int = 1024) -> str:
        """回傳 LLM 的文字完成結果。"""

def get_configured_llm_client() -> Optional[LLMClient]:
    """依優先順序回傳已設定的 LLM client：
    AgentCore > Bedrock (IAM Role) > Anthropic API > OmniRoute > None
    """
```

### Decision 資料結構

```python
@dataclass
class Decision:
    triggered: bool                          # 是否觸發 SOP
    sop_section_id: Optional[str]            # 觸發的 SOP 條號（純數字字串）
    result: dict[str, Any]                   # 情境專屬決定欄位
    reasoning: str                           # 政府版：含 SOP 條號、門檻、處置細節
    public_message: str                      # 民眾版：僅行動建議，不含內部資訊
    source: str                              # "llm" 或 "fallback"
    reasoning_steps: list[ReasoningStep]     # 結構化判斷步驟追蹤
```

### S3 快取鍵格式

```
decisions/{scenario_at}/{segment_id}.json                     # SOP §1 擁塞分級
decisions/{scenario_at}/{station_id}__{decision_kind}.json    # SOP §3/§4 人流判斷
decisions/{scenario_at}/all.json                               # SOP §6 多語通報
incidents/{date}/{event_id}/decisions/{scenario_at}/{alert_kind}.json  # SOP §2/§5 事件判斷
```

## Data Models

### Aurora PostgreSQL Schema

```sql
-- 道路參考資料
road_segments (
  segment_id TEXT PK,
  name TEXT,
  flow_direction TEXT,
  capacity_vph INTEGER,
  route_geojson JSONB,
  intersections JSONB,
  alternative_segment_ids TEXT[],
  nearby_station_ids TEXT[]
)

-- 站點參考資料
stations (
  station_id TEXT PK,
  name TEXT,
  longitude NUMERIC,
  latitude NUMERIC
)

-- 車流時序快照
traffic_snapshots (
  observed_at TIMESTAMPTZ,
  segment_id TEXT FK → road_segments,
  avg_speed_kph NUMERIC,
  vehicle_count INTEGER,
  saturation_score NUMERIC,
  lane_status TEXT,
  PK (observed_at, segment_id)
)

-- 人流時序快照
crowd_snapshots (
  observed_at TIMESTAMPTZ,
  station_id TEXT FK → stations,
  user_count INTEGER,
  stay_time_avg_minutes NUMERIC,
  growth_rate NUMERIC,
  roaming_user_pct NUMERIC,
  PK (observed_at, station_id)
)

-- 事件記錄
incidents (
  event_id TEXT PK,
  incident_type TEXT,
  location TEXT,
  affected_segment TEXT,
  status TEXT,
  severity TEXT,
  description TEXT,
  occurred_at TIMESTAMPTZ
)

-- 決策工作追蹤（內容在 S3）
decision_jobs (
  job_id TEXT PK,
  event_id TEXT FK → incidents,
  scenario_at TIMESTAMPTZ,
  location_id TEXT,
  status TEXT CHECK (queued|processing|ready|failed),
  decision_s3_key TEXT,
  created_at TIMESTAMPTZ
)
```

### 前端狀態模型 (Zustand Store)

```typescript
interface AppState {
  // 模擬時鐘
  currentTime: Date;
  isPlaying: boolean;
  playbackSpeed: number;

  // 場景資料
  roadSegments: RoadSegment[];
  stations: Station[];
  trafficSnapshots: TrafficSnapshot[];
  crowdSnapshots: CrowdSnapshot[];

  // 決策結果
  congestionDecisions: Map<string, CongestionDecision>;
  crowdDecisions: Map<string, CrowdDecision>;
  incidentDecisions: Map<string, IncidentDecision[]>;

  // 警示
  activeAlerts: Alert[];
  alertHistory: Alert[];

  // 操作
  advanceTime(): void;
  setPlaybackSpeed(speed: number): void;
  togglePlayback(): void;
}
```

## Error Handling

### LLM 備援降級策略

```
LLM 呼叫成功 → Decision(source="llm")
       │
       ▼ 失敗（未設定/連線失敗/回應非 JSON）
       │
rules/ 確定性函式 → Decision(source="fallback")
       │
       ▼ 敘事層
       │
LLM 可用 → narrator.summarize() → 白話文
       │
       ▼ 失敗
       │
templates.py → 罐頭文字
```

### JSON 解析修復

Decision Agent 的 `_parse_json_response` 處理以下 LLM 輸出異常：
- Markdown 程式碼區塊包裹（剝除 ` ```json ` 標記）
- 前導文字雜訊（找到第一個 `{` 開始解析）
- 尾端逗號（正則移除 `,}` / `,]`）
- 字串內未跳脫引號（`_escape_stray_quotes` 修復）
- 字串內原始控制字元（`strict=False` 模式）
- 尾端多餘文字（`raw_decode()` 容錯）

### SOP 條號正規化

`_normalize_sop_section_id` 從 LLM 可能回傳的 "第2條"、"SOP §2" 等格式中提取純數字字串，確保 FK 一致性。

### S3 快取錯誤處理

- `NoSuchKey` / `404` → 返回 `None`（快取未命中，正常流程）
- 其他 `ClientError` → 向上拋出（非預期錯誤）
- 寫入失敗 → 不影響決策結果回傳，但下次會重新呼叫 LLM

### 前端資料模式切換

- `VITE_DATA_SOURCE=demo`：完全離線，從 `public/data/` 載入靜態資料集
- `VITE_DATA_SOURCE=api`：串接後端，路網幾何仍從 `public/data/` 載入（後端尚無對應 API）
- API 呼叫失敗：前端 engine/ 規則引擎可作為降級路徑

## Correctness Properties

*正確性屬性（Correctness Property）描述系統在所有有效執行路徑下應維持的不變量。每條屬性以全稱量化形式表述，作為人類可讀規格與機器可驗證保證之間的橋樑。*

### Property 1: 時間過濾不變量

*For any* scenario_at 時間戳記，後端 city-state 端點回傳的所有 traffic_snapshots 與 crowd_snapshots 的 observed_at 時間戳記必定 ≤ 所請求的 scenario_at 值。

**Validates: Requirements 1.1**

### Property 2: 事實層不預判

*For any* SOP 情境（congestion/accident/mrt_diversion/dome_dispersal/signal_failure/multilingual），facts.py 組裝給 LLM 的事實字典僅包含原始數值（飽和度、人流數、成長率、容量等），不得包含預先計算的判斷結果欄位（如 tier、triggered、main_route、selected）。

**Validates: Requirements 2.2, 3.2, 4.2, 5.2, 6.2, 7.2**

### Property 3: 備援降級一致性

*For any* decide 呼叫，當 LLM client 為 None 或呼叫拋出例外時，回傳的 Decision 物件必定具有 source="fallback"，且其 triggered/result 欄位由對應的 rules/ 確定性函式計算而得。API 端點回傳 HTTP 200，不產生錯誤回應。

**Validates: Requirements 2.3, 3.3, 4.3, 5.3, 6.3, 7.4, 14.2, 15.2**

### Property 4: 快取冪等性

*For any* (location_id, scenario_at) 組合，當 S3 快取中已存在該組合的決策物件時，後續相同組合的 decide 呼叫必定直接回傳快取結果，不重新呼叫 LLM client。重複呼叫回傳的決策內容與首次呼叫完全一致。

**Validates: Requirements 2.4, 10.2**

### Property 5: 快取鍵隔離

*For any* 同一 event_id 的兩種 SOP 檢查（alert_kind="accident" 與 alert_kind="signal_failure"），其 S3 快取物件鍵必定不同，儲存與讀取操作互不覆蓋。同理適用於同一 station_id 的不同 decision_kind（mrt_diversion 與 dome_dispersal）。

**Validates: Requirements 3.4, 4.4, 5.4, 6.4, 16.2**

### Property 6: 候選路線結構完整性

*For any* 事故疏散情境中的候選替代路線，facts 組裝的每條候選路線必定包含 capacity_vph、is_direct_intersection、is_upstream 與 current_saturation 四個結構性事實欄位，且不包含 main_route 或 selected 等預選欄位。

**Validates: Requirements 3.1, 3.2**

### Property 7: 未對應路口陣列等長

*For any* 道路路網拓撲中包含未對應路口名稱的路段，facts 組裝產出的交叉路口陣列長度必定等於原始 intersections 陣列長度，未對應位置以 None 填充。

**Validates: Requirements 3.5**

### Property 8: ETE 公式確定性

*For any* 有效的 severity 與 avg_saturation 輸入值，ETE 計算結果必定等於 `base_clearance(severity) + max(0, (avg_saturation - 0.5) * 60)`，且計算過程不呼叫任何 LLM client。

**Validates: Requirements 8.1**

### Property 9: S3 鍵冒號替換

*For any* 包含冒號字元的 ISO 8601 scenario_at 時間戳記，產出的 S3 物件鍵中所有冒號必定被替換為連字號（`-`），最終鍵不包含任何冒號字元。

**Validates: Requirements 10.4**

### Property 10: 未觸發決策無民眾訊息

*For any* Decision 物件，當 triggered=false 時，public_message 欄位必定為空字串。

**Validates: Requirements 11.3**

### Property 11: LLM 供應商優先序

*For any* 環境變數組合，get_configured_llm_client() 的選擇結果必定遵循：有 BEDROCK_AGENTCORE_RUNTIME_ARN → AgentCore；否則有 BEDROCK_MODEL_ID → Bedrock；否則有 ANTHROPIC_API_KEY → Anthropic；否則有 OMNIROUTE_BASE_URL → OmniRoute；否則 → None。高優先者設定後，低優先者永不被選用。

**Validates: Requirements 14.1**

### Property 12: 事件雙重 SOP 檢查

*For any* 事件評估呼叫，無論事件的 type 或 description 欄位內容為何，系統必定同時且獨立執行 decide_accident（SOP §2）與 decide_signal_failure（SOP §5）兩項檢查，回傳的 aiDecisions 陣列包含至少兩個元素，各自具有獨立的 triggered 狀態。

**Validates: Requirements 6.1, 16.1, 16.3**

### Property 13: 多語輸出確定性

*For any* 有效的 messageType 與 values 輸入，generate_multilingual 函式必定產出恰好包含 zh、en、ja、ko 四個鍵的字典，且相同輸入永遠產出相同輸出（不依賴 LLM client）。

**Validates: Requirements 7.3, 15.3**

### Property 14: 敘事層不改判斷

*For any* 已產出的 Decision 物件，經過 narrator.summarize() 處理後，原始 Decision 的 triggered、sop_section_id 與 result 欄位不得被修改。summarize 僅產出額外的敘事文字。

**Validates: Requirements 15.1**

## Testing Strategy

### 屬性測試（Property-Based Testing）

針對上述 14 條正確性屬性，使用 Hypothesis（Python 後端）與 fast-check（TypeScript 前端）進行屬性測試：

| 屬性 | 測試框架 | 最少迭代次數 | 生成策略 |
|------|----------|-------------|----------|
| Property 1 時間過濾 | Hypothesis | 100 | 隨機 ISO8601 時間戳記 + 隨機快照集合 |
| Property 2 事實不預判 | Hypothesis | 100 | 隨機飽和度/人流/路網資料 |
| Property 3 備援降級 | Hypothesis | 100 | 隨機 scope + mock LLM 回傳 None/Exception |
| Property 4 快取冪等 | Hypothesis + moto | 100 | 隨機 (location_id, scenario_at) + mock S3 |
| Property 5 快取鍵隔離 | Hypothesis + moto | 100 | 隨機 event_id + 兩種 alert_kind |
| Property 6 候選路線完整 | Hypothesis | 100 | 隨機路網拓撲 + 事故位置 |
| Property 7 陣列等長 | Hypothesis | 100 | 隨機含未對應名稱的路口陣列 |
| Property 8 ETE 公式 | Hypothesis | 100 | 隨機 severity 與 saturation ∈ [0, 1] |
| Property 9 冒號替換 | Hypothesis | 100 | 隨機 ISO8601 時間戳記 |
| Property 10 未觸發無訊息 | Hypothesis | 100 | 隨機 Decision(triggered=False) |
| Property 11 供應商優先序 | Hypothesis | 100 | 隨機環境變數子集組合 |
| Property 12 雙重 SOP | Hypothesis + moto | 100 | 隨機事件類型與描述 |
| Property 13 多語確定性 | Hypothesis | 100 | 隨機 messageType + values |
| Property 14 敘事不改判斷 | Hypothesis | 100 | 隨機 Decision 物件 |

### 單元測試（Example-Based）

| 測試範圍 | 框架 | 重點案例 |
|----------|------|----------|
| 前端 engine/ 規則鏡像 | Vitest | 與後端 test_rules.py 相同黃金案例 |
| 前端 store 狀態管理 | Vitest | 播放/暫停/速度調整 |
| 前端 services/ API 呼叫 | Vitest | demo/api 模式切換 |
| 後端 handler 路由 | pytest | 各端點正常/異常回應 |
| 後端 rules/ 確定性計算 | pytest | 門檻邊界值（0.84→Normal, 0.85→B, 0.95→A） |
| LLM JSON 解析修復 | pytest | 前導文字/尾端逗號/未跳脫引號/控制字元 |

### 整合測試（Integration）

| 測試範圍 | 工具 | 說明 |
|----------|------|------|
| city-state 端到端流程 | pytest + moto | 模擬完整輪詢流程（DB → facts → decide → cache → response） |
| 事件注入端到端流程 | pytest + moto | POST incidents → evaluate → 雙重 SOP 結果 |
| 對話端點 | pytest + mock LLM | 驗證 SOP 全文傳入 + 回覆格式 |
| Terraform plan | terraform plan | 驗證所有資源宣告無衝突 |
| 前端 E2E | Playwright | 地圖載入、警示彈出、對話互動 |
