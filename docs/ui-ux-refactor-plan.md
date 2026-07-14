# AI City Commander UI/UX Refactor Plan

## 目標

目前專案已具備地圖、路段狀態、人流資料、事件注入、SOP 推理、ETE 估算、AI 問答與報告匯出等功能，但畫面資訊同時攤開，使用者進入後不容易判斷：

- 現在城市狀態是否危急
- 哪個事件最需要處理
- AI 建議下一步做什麼
- 建議背後依據哪些 SOP 與資料

本次規劃的目標是把介面從「資料總覽 dashboard」重構為「AI 城市事件指揮台」，讓 demo 流程更清楚，也更貼近問題文檔要求。

## 核心設計原則

1. 優先呈現決策，不優先呈現所有資料。
2. 第一眼只回答「發生什麼事、嚴重度、建議行動、依據」。
3. 詳細資料放在可展開區塊、分頁或 drill-down。
4. 地圖作為主視覺，用顏色、線條、標記承載狀態。
5. AI 推理需要可解釋，但不應一開始塞滿畫面。
6. 時間軸要能呈現事件演進，符合 dynamic time-series dashboard 要求。

## 目前問題整理

### 1. 資訊層級不清楚

目前左側、右側、底部同時顯示大量清單與卡片。使用者會看到很多資料，但不知道哪個最重要。

### 2. 決策流程被拆散

SOP 推理、ETE、AI 問答、多語警示分散在右側多個區塊中，缺少一條從事件到建議的閱讀路徑。

### 3. 清單太早出現

所有路段與所有站點一開始就顯示，造成畫面密度過高。這些資料應該先摘要，再讓使用者點進去看完整內容。

### 4. 時間演進不夠突出

文檔要求 dynamic time-series dashboard，但目前時間控制比較像播放工具，尚未成為分析與敘事主軸。

### 5. 文案與編碼問題（已覆查）

實際檢查目前 `docs/problem-brief.md` 與 `frontend/src` 內所有文案（`pick(language, zh, en)` 呼叫、CSV/JSON 載入邏輯）後，**沒有發現亂碼**，中文字串皆正常。這一項先前可能是舊版狀態，或只是 Windows 終端機（PowerShell 預設非 UTF-8）在 `git`/`node` 輸出時顯示異常，並非檔案內容本身損壞。

建議仍保留一次快速覆查（正式 demo 前用瀏覽器實際檢視，而非只看終端機輸出），但不需要當作獨立大工程，Phase 0 可簡化為「confirm only」。

## 現況覆查（對照實際程式碼後的結論）

實際讀過 `frontend/src` 後確認：

- 元件切分已經很乾淨。`ReasoningChain`、`ETEBreakdownCard`、`ChatPanel`、`MultilingualPreview`、`IncidentPriorityList`、`SegmentList`、`StationList`、`Legend` 全部各自獨立、直接從 `useAppStore` 取資料，彼此沒有耦合。**這代表本次重構主要是「排版與資訊揭露順序」的重組，不需要重寫商業邏輯**，風險與工時都比"重寫"低很多，適合在黑客松時程內完成。
- `store/appStore.ts` 已經把五項必做模組的判定邏輯、SOP 引用、ETE 計算、推理鏈全部做好且與 `docs/problem-brief.md` 的規則一致（§1–§7 皆有對應程式碼與註解）。技術可行性與主題切合度（合計70%）的底層邏輯已經到位，目前風險集中在「畫面能不能清楚呈現這些已經算好的結果」。
- `package.json` 已安裝 `recharts`，但目前整個 `src` 沒有任何檔案引用它——時間序列圖表是**唯一還沒做、但已具備套件與資料**的部分（`traffic`、`crowd` 陣列在 store 裡已經是完整時間序列）。這件事應該提高優先度，因為 dynamic time-series dashboard 是文檔明列的必做模組，直接對應評分項目。
- `Header.tsx` 其實已經有部分 Command Bar 的雛形（Tier 統計、已觸發 SOP 條款、語言/主題切換），可以直接擴充，不需要整個砍掉重練；缺的是 active incidents 數、最高 ETE，以及目前散落在 `MapStage` 底部的播放/速度控制。

## 建議資訊架構

建議將畫面整理成五個主要區域：

```text
┌──────────────────────────────────────────────────────────────┐
│ Command Bar: time, city risk, active incidents, SOP, ETE      │
├───────────────┬──────────────────────────────┬───────────────┤
│ Situation     │ Main Map Workspace           │ AI Decision   │
│ Summary       │                              │ Panel         │
├───────────────┴──────────────────────────────┴───────────────┤
│ Incident Timeline / Replay / Priority                         │
└──────────────────────────────────────────────────────────────┘
```

### 1. Command Bar

用途：提供全域狀態，不放細節。

建議顯示：

- 目前時間
- 城市風險狀態
- Critical / Tier A 路段數
- Active incidents 數量
- 最高 ETE
- 已觸發 SOP 條款
- 播放 / 暫停 / 速度控制

實作備註：`Header.tsx` 目前已有 Tier 統計與 SOP 條款區塊，可直接在同一個元件擴充，加入 `activeIncidents.length`（來自 store）與 `Math.max(...Object.values(incidentEte))`，並把現在放在 `MapStage` 底部的 `TimeFilter`（播放/暫停/速度）搬進來合併，不需要新建元件、也不需要改動它内部邏輯。

### 2. Main Map Workspace

用途：成為主視覺與主要互動區。

建議顯示：

- 路段飽和度：以顏色表示 Normal / Tier B / Tier A
- 事故來源：明確標記 incident source
- 疏散主路線：粗線或高亮線
- 次要路線：較淡的線
- 被排除路線：虛線或警示樣式
- 人流熱點：用圓點大小或 heat marker 表示
- 地圖上保留一個小型「目前建議」浮層

不建議：

- 在地圖周圍堆太多卡片
- 同時顯示大量文字說明

### 3. Situation Summary

用途：讓使用者快速掌握城市情勢。

建議使用 tabs：

- `Overview`
- `Roads`
- `Crowd`

`Overview` 預設顯示：

- Top 3 風險路段
- Top 3 人流熱點
- 當前最大風險來源
- 小型趨勢圖

`Roads` 顯示：

- 路段列表
- saturation
- avg speed
- vehicle count
- lane status
- 可排序與篩選

`Crowd` 顯示：

- station user count
- growth rate
- roaming percentage
- 是否觸發多語警示

### 4. AI Decision Panel

用途：把 AI 應變流程整理成單一路徑。

建議順序：

1. 事件摘要
2. AI 建議行動
3. 命中 SOP 條款
4. 推理步驟
5. ETE 拆解
6. What-if 問答
7. 多語警示預覽

目前的元件可以重新組合：

- `ReasoningChain` 改為可展開步驟
- `ETEBreakdownCard` 放在建議之後
- `ChatPanel` 放到 What-if tab
- `MultilingualPreview` 放到警示 tab 或事件需要時才出現

實作備註：這四個元件目前都是無狀態地直接讀 `useAppStore`，彼此沒有 props 依賴，所以「整合」實務上只是換一個外殼容器（例如本地 `useState<TabKey>` 控制的 tab 或 accordion），把四個既有元件依序 mount／unmount，不需要動它們內部的程式碼。優先順序建議：先做「結論永遠可見＋其餘可收合」，例如預設只展開 `ReasoningChain` 的結論列與 `ETEBreakdownCard`，`ChatPanel`／`MultilingualPreview` 收在分頁裡，比一次做完整 7 步驟排版更快看到效果。

### 5. Incident Timeline

用途：強化事件演進與 demo 敘事。

建議顯示：

- 17:00 到 22:30 的時間軸
- 壅塞升級節點
- 人流暴增節點
- 事故發生節點
- SOP 觸發節點
- 使用者可點擊節點跳轉時間

底部原本的 `IncidentPriorityList` 可以整合進時間軸，或在 active incident 時顯示為 priority lane。

## 建議資料視覺化

> 實作備註：`recharts` 已在 `package.json` 但目前未被任何檔案引用，以下圖表可直接用它實作（`AreaChart`/`LineChart` + `ReferenceLine` 標門檻、`ReferenceDot` 標事件節點），資料來源 `traffic`、`crowd` 在 `appStore` 已是完整時間序列陣列，不需要額外資料整理。建立圖表時請套用 `dataviz` skill 的配色與樣式規則，確保與其餘 UI 視覺一致。

### 1. 路段飽和度趨勢圖

資料來源：`city_traffic_flow.csv`

顯示內容：

- `Saturation_Score` 隨時間變化
- 標記 Tier B / Tier A 閾值
- 可選取重點路段

價值：

- 展示 dynamic time-series dashboard
- 讓壅塞升級有明確證據

### 2. 人流與漫遊比例圖

資料來源：`signaling_crowd_density.csv`

顯示內容：

- `User_Count`
- `Growth_Rate`
- `Roaming_User_Pct`

價值：

- 支援 MRT diversion、dome dispersal、多語警示等 SOP

### 3. 事件優先矩陣（優先度較低，視時間再做）

資料來源：`live_incidents.json` 與 ETE 計算結果

顯示內容：

- X 軸：ETE
- Y 軸：severity
- 點大小：影響路段或人流規模

價值：

- 說明 AI 為什麼優先處理某事件

實作備註：`live_incidents.json` 目前只有 3 起事件，散點圖在資料量這麼小的情況下說服力有限，且現有 `IncidentPriorityList` 已用文字排序表達了同樣的「為何優先處理」邏輯。建議把這個圖表列為時間允許才做的加分項，優先資源應該放在 #1、#2 的時間序列趨勢圖與下方的 Incident Timeline，這兩者才是文檔明列必做、且評分直接對應的項目。

### 4. ETE Breakdown

資料來源：`calcETE`

顯示內容：

- base clearance
- congestion penalty
- final ETE

價值：

- 強化可解釋性
- 對應文檔中的 reasoning and explainability

實作備註：`ETEBreakdownCard.tsx` 目前只顯示最終 ETE 數字與 `reasoningSteps` 裡 `final` 步驟的文字說明，尚未把 base clearance 與 congestion penalty 拆成兩個可視化數字/長條。`calcETE()` 已回傳 `{ ete, breakdown }`，建議讓它回傳結構化欄位（base、penalty、total）而非只有一段文字，UI 才能畫出真正的分解長條圖。

### 5. SOP Reasoning Chain

資料來源：`reasoningLog`

顯示方式：

- 預設只顯示結論與命中 SOP
- 點擊後展開每一步
- 每一步標示 pass / fail / final

價值：

- 保留完整推理，但降低第一眼負擔

實作備註：`ReasoningChain.tsx` 目前是一次性 render 全部步驟（無摺疊），要做到「預設只顯示結論，點擊展開」需要加一個本地 `expanded` state 並預設只 render `status === "final"` 的那一步，其餘步驟收合，這是小改動，不涉及資料層。

## 建議元件重構

### App Layout

目前：

- `Header`
- `LeftPanel`
- `MapStage`
- `RightPanel`
- `BottomBar`
- `AlertOverlay`（疊在地圖上的 toast 通知，目前運作良好、已符合「Agent 主動預警」要求，重構時應保留，並可讓 Command Bar 的 active incidents／ETE 數字與它共用同一批 alert 資料）

建議：

- `CommandBar`
- `SituationPanel`
- `MapWorkspace`
- `DecisionPanel`
- `IncidentTimeline`

可以先保留現有元件，逐步搬移內容，不需要一次重寫所有邏輯。

### LeftPanel

重構方向：

- 從完整清單改成摘要面板
- 加入 tabs
- 預設只顯示重點資料
- 完整 road / station list 移到對應 tab

### RightPanel

重構方向：

- 從四格卡片改成事件決策流程
- 先結論，再依據
- Chat 與多語預覽改成次層內容

### BottomBar

重構方向：

- 從事件列表改成時間軸
- 保留事件 priority，但變成 active incident lane
- 支援點擊時間節點

### MapStage

重構方向：

- 保留地圖主體
- 強化 route visualization
- 減少周邊浮動控制
- 地圖控制集中為少量 icon buttons
- 將事件建議摘要固定在地圖角落

## 分階段執行計畫

### Phase 0：覆查文字與編碼（快速確認，非修復工程）

目標：

- 用瀏覽器（而非終端機）實際檢視文檔與前端文案，確認無亂碼（目前覆查結果：正常）
- 若真發現特定畫面亂碼，當場修正該處

成果：

- 確認 demo 不會出現亂碼
- UI 文案可讀
- SOP 與資料欄位可被正確解釋

### Phase 1：重新整理畫面骨架

目標：

- 建立新的 dashboard layout
- 把資訊分成 Command、Situation、Map、Decision、Timeline

成果：

- 第一眼更清楚
- 使用者知道從哪裡開始看

### Phase 2：重構 Situation Summary

目標：

- 左側改為摘要 + tabs
- Top risks 優先於完整清單

成果：

- 降低資訊噪音
- 保留 drill-down 能力

### Phase 3：重構 AI Decision Panel

目標：

- 整合事件、建議、SOP、推理、ETE
- 讓 AI 決策流程清楚可讀

成果：

- 更符合 AI Agent 與 explainability 要求
- demo 敘事更順

### Phase 4：加入時間序列視覺化

目標：

- 加入路段飽和度趨勢
- 加入人流趨勢
- 加入事件時間軸

成果：

- 符合 dynamic time-series dashboard
- 能展示事件演進與 SOP 觸發時機

### Phase 5：視覺與互動 polish

目標：

- 統一 spacing、字級、色彩、狀態標籤
- 減少卡片堆疊
- 檢查 mobile / desktop 響應式

成果：

- UI 看起來完整、有整理過
- 使用體驗更接近正式指揮台

## Demo 建議流程

1. 進入畫面，Command Bar 顯示城市正常監控中。
2. 播放時間軸，路段 saturation 上升。
3. Tier A 或 SOP 條款觸發，Decision Panel 顯示 AI 建議。
4. 注入 road accident incident。
5. 地圖高亮事故路段、主疏散路線與替代路線。
6. Decision Panel 顯示 SOP 命中、推理步驟與 ETE。
7. 切到 What-if，詢問替代情境。
8. 匯出報告。

## 優先處理清單

建議優先順序（對照 `problem-brief.md` §6 評分權重調整）：

1. 快速覆查文案顯示是否正常（非大工程，見上方「文案與編碼問題」覆查結論）。
2. 建立新的資訊架構與 layout（Command Bar／Situation／Map／Decision／Timeline）。
3. 補上時間序列趨勢圖與 Incident Timeline —— **這項提前到第 3 順位**，因為 dynamic time-series dashboard 是文檔明列必做模組且直接對應「主題切合度」35% 評分，而目前是唯一完全沒做（`recharts` 裝了但沒用）的部分；其餘多是排版重組。
4. 重構右側 AI decision flow（多數是換外殼容器，見上方實作備註）。
5. 重構左側 summary/tabs。
6. 最後做視覺 polish（對應 +5% Dashboard 設計加分項）。

> 附帶發現：`MultilingualPreview.tsx` 已支援中/英/日/韓四語言，代表 `problem-brief.md` §6 加分項「+5%：多語化通報支援中英以外語言」的功能面已經完成，重構時只需確保它在新版 UI 中維持可見、好找即可，不需要重新開發。

## 總結

本專案的關鍵不是再加入更多功能，而是把既有功能整理成清楚的指揮流程。使用者應該先看到結論，再看到資料；先看到 AI 建議，再看到推理細節；先掌握事件演進，再進入完整清單。

重構後的目標體驗是：

> AI City Commander 是一個能協助城市應變人員快速理解事件、排序優先級、依據 SOP 產生建議，並用視覺化資料說明決策理由的智慧指揮台。
