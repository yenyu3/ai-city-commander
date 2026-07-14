# Header 模式切換功能規劃

## 目標

在專案 Header 右側加入「模式切換」按鈕，讓同一套 AI City Commander 可以依使用者身分切換資訊密度、可見資料與操作功能。初步規劃兩種模式：

- 一般民眾模式：以「安全、可理解、可行動」為核心，提供市民需要知道的交通、人流、避難、通知與建議。
- 政府單位模式：以「指揮、判斷、協調」為核心，保留完整資料、SOP 推理、AI 決策依據與應變操作。

此功能的本質不是單純換版面，而是同一份城市狀態資料依不同受眾做分層呈現。政府單位看到完整決策視角，一般民眾看到經過摘要、去敏感化、以行動建議為主的公開資訊。

## 設計原則

1. 同源資料，不同視圖  
   交通壅塞、人流密度、事故、SOP、ETE 等資料仍由同一個 store 與規則引擎產生，再透過模式決定顯示粒度。

2. 民眾模式避免造成恐慌  
   不直接呈現過細的事故處置細節、內部 SOP 條文、AI 推理過程或敏感座標，改用清楚的風險等級、建議路線與官方訊息。

3. 政府模式保留可追溯性  
   顯示 SOP 條件、推理鏈、ETE 拆解、事故優先序、替代路線選擇原因與跨單位協作資訊。

4. 切換後保持情境連續  
   使用者切換模式時，時間軸、目前事件、地圖位置不應重置，只更換可見資訊與操作能力。

5. 可逐步實作  
   第一階段先完成 UI 切換與資料篩選，第二階段再加入民眾專屬公告、政府專屬任務派發、權限與匯出。

## Header 入口規劃

### 位置

放在 Header 右側，目前已有主題切換與語言切換按鈕。建議順序如下：

```text
[模式切換] [主題切換] [語言切換]
```

### 控制形式

建議使用 segmented control 或帶圖示的切換按鈕：

```text
一般民眾 | 政府單位
```

若空間不足，手機版可改成單一 icon button，點擊後展開選單：

```text
目前模式：一般民眾
- 一般民眾
- 政府單位
```

### 狀態命名

建議在前端使用清楚的 enum：

```ts
type ViewerMode = "public" | "government";
```

顯示文字：

| 值 | 中文顯示 | 英文顯示 |
| --- | --- | --- |
| `public` | 一般民眾 | Public |
| `government` | 政府單位 | Government |

### 預設模式

建議預設為 `government`，理由是目前專案主要是城市應變指揮台，現有頁面內容已偏向政府或指揮中心情境。

若未來此系統要公開展示給民眾使用，則正式部署環境可以預設為 `public`，內部 demo 或管理入口預設為 `government`。

## 兩種模式的資訊架構

## 一般民眾模式

### 核心任務

一般民眾打開系統時，最需要回答的是：

- 我現在所在區域安不安全？
- 哪些道路、捷運站、人潮區域要避開？
- 我應該改走哪裡？
- 官方目前發布了什麼通知？
- 事件大概多久會緩解？

### Header 顯示內容

一般民眾模式的 Header 應精簡，只保留和行動決策直接相關的資訊。

建議顯示：

| 區塊 | 顯示內容 |
| --- | --- |
| 城市狀態 | 正常 / 注意 / 壅塞 / 緊急 |
| 目前時間 | 模擬或即時時間 |
| 影響區域數 | 例如「3 個區域受影響」 |
| 最高預估恢復時間 | 例如「約 45 分鐘」 |
| 模式切換 | 一般民眾 / 政府單位 |

不建議顯示：

- Tier A / Tier B 內部分類
- SOP 條文編號
- active incidents 原始數量
- AI 推理標籤
- 內部處置狀態

### 地圖視圖

一般民眾模式的地圖要以「可理解的公開風險圖」為主。

建議顯示：

- 道路狀態：順暢、壅塞、封閉、建議避開
- 捷運站與人潮熱點：正常、擁擠、建議分流
- 事故或異常區域：用模糊化範圍呈現，不顯示過細座標
- 建議替代路線：以「建議改道」方式呈現
- 安全出口、疏散方向或避開區域

不建議顯示：

- 精準事故處置點
- 內部警消調度路線
- 政府單位的主備援路線判斷細節
- 原始 segment id、BS id
- SOP 觸發條件與規則門檻

### 左側資訊面板

可將目前 Situation Summary 改成「市民狀態摘要」。

建議 tabs：

| Tab | 內容 |
| --- | --- |
| 總覽 | 城市狀態、受影響區域、主要提醒 |
| 交通 | 封閉道路、壅塞路段、建議改道 |
| 人潮 | 擁擠站點、建議避開出口、分流建議 |
| 通知 | 官方公告、多語言提醒、最新更新 |

每張資訊卡應使用自然語言：

```text
信義快速道路往市府方向車流壅塞，建議改走基隆路或延後出發。
```

避免：

```text
RD_TPE_001 Saturation_Score=0.93, Tier B triggered.
```

### 右側 AI 面板

一般民眾模式不應顯示完整 AI Decision Panel，而應改成「市民助手」。

建議功能：

- 詢問目前路況
- 詢問某地點是否適合前往
- 取得替代路線建議
- 查詢附近安全區域或捷運分流建議
- 產生多語言公告

範例問題：

```text
我現在要去台北小巨蛋，建議怎麼走？
```

```text
板南線現在人多嗎？需要避開哪一站？
```

```text
請用英文告訴外國旅客現在該怎麼移動。
```

回答風格：

- 簡短
- 明確
- 以建議行動為主
- 不提內部 SOP 或模型推理細節

### 底部時間軸

一般民眾模式可將 Incident Timeline 改成「最新更新」。

建議顯示：

- 事件開始時間
- 官方發布時間
- 交通恢復進度
- 最新改道或分流建議
- 預估解除時間

不顯示：

- 內部處置節點
- SOP pass / fail
- 優先序排序細節
- AI 推理過程

### 一般民眾模式的客製功能

1. 目的地安全查詢  
   使用者輸入目的地，系統回覆是否建議前往、預估延誤、替代交通方式。

2. 個人化路線提醒  
   依使用者選定的起終點，篩出和自己相關的事故、壅塞、人潮資訊。

3. 多語言公告  
   一鍵切換中文、英文、日文、韓文等公告格式，適合觀光客或大型活動現場。

4. 避開區域提示  
   用簡單風險等級提醒「建議避開」、「可通行但延誤」、「正常」。

5. 通知訂閱  
   使用者可追蹤特定區域或路線，收到更新。

6. 無障礙與弱勢族群資訊  
   加入電梯、無障礙出口、醫療點、臨時休息區等資訊。

## 政府單位模式

### 核心任務

政府單位模式要支援的是應變指揮流程：

- 哪些事件優先處理？
- 哪些 SOP 被觸發？
- AI 為什麼建議這個處置？
- ETE 如何計算？
- 替代路線或分流策略是否合理？
- 哪些訊息需要對外發布？
- 哪些單位需要被通知或協調？

### Header 顯示內容

政府模式可保留目前 Command Bar 的資訊密度。

建議顯示：

| 區塊 | 顯示內容 |
| --- | --- |
| 城市風險 | Normal / Elevated / Critical |
| 目前時間 | 模擬或即時時間 |
| Tier B / Tier A | 各級壅塞路段數 |
| Active Incidents | 目前事件數 |
| Max ETE | 最長預估處理時間 |
| SOP Tags | 已觸發 SOP 條文 |
| 模式切換 | 一般民眾 / 政府單位 |

### 地圖視圖

政府模式地圖應保留完整營運資訊。

建議顯示：

- 完整 road segment 狀態
- Tier A / Tier B 顏色分級
- incident source
- evacuation main route
- secondary route
- station crowd density
- signal failure / power failure / accident impact
- road network graph
- segment card drill-down
- time filter 與 replay

可新增功能：

- 勾選圖層：交通、人流、事故、SOP、分流路線、警消資源
- 點擊路段後查看原始指標
- 對單一事件套用 what-if 模擬
- 顯示事件影響半徑與跨區域連鎖影響

### 左側資訊面板

政府模式可維持 Situation Summary，並強化 drill-down。

建議 tabs：

| Tab | 內容 |
| --- | --- |
| Overview | Top risks、Top affected routes、active SOP |
| Roads | saturation、avg speed、vehicle count、lane status |
| Crowd | user count、growth rate、roaming pct |
| Resources | 可用警力、交管人員、捷運疏導人員、醫療點 |

### 右側 AI Decision Panel

政府模式保留完整 AI Decision Panel。

建議區塊：

- Decision Summary
- Reasoning Chain
- SOP Trigger Detail
- ETE Breakdown
- What-if Chat
- Multilingual Preview
- Public Message Draft
- Recommended Assignments

### 底部時間軸

政府模式保留 Incident Timeline 與 Incident Priority List。

建議顯示：

- 事件優先序
- 事件注入或發生時間
- SOP 觸發時間
- 決策建議產生時間
- 對外公告時間
- 預估處理完成時間
- 已完成 / 進行中 / 待確認狀態

### 政府單位模式的客製功能

1. SOP 觸發解釋  
   顯示每個 SOP 條件的 pass / fail / final 狀態。

2. ETE 拆解  
   顯示 base clearance、congestion penalty、final ETE。

3. 事件優先序排序  
   依 severity、影響範圍、ETE、人流密度、替代路線可用性排序。

4. 應變任務派發  
   將 AI 建議轉成任務，例如「派遣交管人員至 A 路口」、「通知捷運站啟動分流」。

5. 對外公告草稿  
   將內部決策轉成民眾可讀的公告，並支援多語言版本。

6. What-if 模擬  
   支援問題如「如果 RD_TPE_002 持續封閉 30 分鐘，哪條路線會成為瓶頸？」

7. 匯出事件報告  
   匯出事件時間軸、SOP 依據、AI 建議、執行結果與公告紀錄。

## 模式差異總表

| 功能區 | 一般民眾 | 政府單位 |
| --- | --- | --- |
| Header | 城市狀態、受影響區域、恢復時間 | 風險等級、Tier、incident、ETE、SOP |
| 地圖 | 公開風險圖、建議避開區域 | 完整路網、事件來源、主備援路線 |
| 左側面板 | 市民狀態摘要、交通、人潮、通知 | Situation Summary、Roads、Crowd、Resources |
| 右側面板 | 市民助手、路線與安全建議 | AI Decision Panel、SOP、ETE、What-if |
| 底部區 | 最新更新、官方公告 | Incident Timeline、Priority List |
| 資料粒度 | 摘要、模糊化、行動導向 | 完整、可追溯、可操作 |
| 操作能力 | 查詢、訂閱、語言切換 | 派發、模擬、匯出、發布草稿 |
| 語氣 | 安定、明確、生活化 | 精準、決策導向、可稽核 |

## 資料篩選與去敏感化規則

### 一般民眾模式

應隱藏或轉譯：

| 原始資料 | 民眾模式顯示 |
| --- | --- |
| `segmentId` | 路名或區域名稱 |
| `stationId` / `BS_ID` | 站點或地標名稱 |
| `Saturation_Score` | 順暢 / 壅塞 / 建議避開 |
| `Tier A/B` | 緊急 / 注意 |
| `sopRef` | 官方建議或公告依據，不顯示條號 |
| `reasoningSteps` | 摘要成一段市民建議 |
| `incidentEte` | 約 X 分鐘或「預估較久」 |
| 精準事故座標 | 區域範圍 |

### 政府單位模式

保留完整資料：

- `segmentId`
- `stationId`
- `Saturation_Score`
- `Growth_Rate`
- `Roaming_User_Pct`
- `Tier`
- `sopRef`
- `reasoningSteps`
- `incidentEte`
- `activeIncidents`
- `alerts`

## 建議的前端狀態設計

### Store

在 `useAppStore` 增加：

```ts
type ViewerMode = "public" | "government";

interface AppState {
  viewerMode: ViewerMode;
  setViewerMode(mode: ViewerMode): void;
}
```

可同步寫入 `localStorage`：

```text
viewerMode=public
viewerMode=government
```

### Selector

建議新增 selector 或 utility，避免每個 component 自己判斷太多規則：

```ts
const isPublicMode = viewerMode === "public";
const isGovernmentMode = viewerMode === "government";
```

可以再建立資料轉換函式：

```ts
getPublicAlerts(alerts)
getPublicSegments(segments)
getPublicIncidents(activeIncidents)
getGovernmentDecisionContext(state)
```

## 建議元件調整

### Header

新增：

- `ViewerModeSwitch`

整合位置：

```text
frontend/src/components/Header/Header.tsx
frontend/src/components/Header/Header.module.css
```

### App Layout

初期不需要建立兩套路由，建議在同一個 layout 內做條件式內容：

```tsx
{viewerMode === "public" ? <PublicLeftPanel /> : <LeftPanel />}
{viewerMode === "public" ? <PublicAssistantPanel /> : <RightPanel />}
{viewerMode === "public" ? <PublicUpdateBar /> : <BottomBar />}
```

如果第一階段想降低改動量，也可以先在現有元件內依模式切換內容：

- `LeftPanel`：切換 tabs 與卡片文字
- `RightPanel`：政府顯示 AI Decision，民眾顯示 Public Assistant
- `BottomBar`：政府顯示 timeline，民眾顯示 latest updates
- `MapStage`：依模式切換圖層與標籤粒度

### 建議新增元件

| 元件 | 用途 |
| --- | --- |
| `ViewerModeSwitch` | Header 右側模式切換 |
| `PublicStatusPanel` | 民眾模式左側摘要 |
| `PublicAssistantPanel` | 民眾模式 AI 問答 |
| `PublicUpdateBar` | 民眾模式最新更新 |
| `PublicMapLegend` | 民眾模式地圖圖例 |
| `PublicNoticeCard` | 官方公告卡片 |

## UI 文案規劃

### 一般民眾模式文案

建議使用：

- 目前城市狀態
- 建議避開
- 可通行但可能延誤
- 建議改道
- 人潮較多
- 官方提醒
- 預估恢復
- 最新更新

避免使用：

- Triggered
- SOP clause
- Tier A / B
- ETE breakdown
- severity
- reasoning chain
- pass / fail

### 政府單位模式文案

可使用：

- City Risk
- Active Incidents
- SOP Triggered
- ETE
- Reasoning Chain
- Incident Priority
- Evacuation Route
- Congestion Penalty
- What-if
- Export Report

## 使用情境範例

### 情境 1：大型活動散場

一般民眾看到：

```text
小巨蛋周邊人潮增加，建議往南京復興站分流，避免停留於主入口。
```

政府單位看到：

```text
BS_TPE_DOME crowd peak exceeded threshold. SOP 4 triggered.
Growth_Rate=-0.22, dispersal phase active. Recommend staged outbound control.
```

### 情境 2：道路事故封閉

一般民眾看到：

```text
市府周邊部分道路封閉，建議改走基隆路，預估延誤約 30-45 分鐘。
```

政府單位看到：

```text
TPE_2026_ACC_001 triggered SOP 2 / SOP 7.
Main route selected: RD_TPE_004.
ETE = base 60 + congestion penalty 18 = 78 min.
```

### 情境 3：捷運站人潮過高

一般民眾看到：

```text
國父紀念館站人潮較多，建議改由市政府站或忠孝敦化站進出。
```

政府單位看到：

```text
BS_MRT_BL17 User_Count=28,500, Growth_Rate=0.34.
SOP 3 triggered. Recommend MRT diversion and crowd control deployment.
```

## 實作階段建議

### Phase 1：模式狀態與 Header 按鈕

目標：

- 在 Header 右側加入模式切換
- 在 store 增加 `viewerMode`
- 使用 `localStorage` 記住模式
- Header 指標依模式顯示不同內容

完成後可以驗證：

- 切換模式不會重置時間軸
- reload 後模式仍保留
- Header 資訊在兩模式明顯不同

### Phase 2：資料篩選與文字轉譯

目標：

- 建立 public mode 資料 selector
- 將內部 id、SOP、Tier 轉成民眾語言
- 地圖 label 與卡片內容依模式切換

完成後可以驗證：

- 民眾模式不出現 segment id、SOP 條號、reasoning chain
- 政府模式仍可看到完整資料

### Phase 3：民眾模式專屬面板

目標：

- 新增 `PublicStatusPanel`
- 新增 `PublicAssistantPanel`
- 新增 `PublicUpdateBar`
- 保留現有政府模式 panel

完成後可以驗證：

- 民眾模式第一眼能看到「該去哪、避開哪、多久恢復」
- 政府模式仍維持原本指揮台資訊

### Phase 4：政府模式進階操作

目標：

- 加入任務派發草稿
- 加入對外公告草稿
- 強化 what-if 與 report export

完成後可以驗證：

- 政府模式能從事件到決策、公告、報告形成完整流程

### Phase 5：權限與部署策略

目標：

- 正式環境可依登入身分決定預設模式
- 未登入者只允許一般民眾模式
- 政府模式需權限或內部入口

完成後可以驗證：

- 公開使用者無法看到內部 SOP 與決策細節
- 政府帳號可切換與操作完整功能

## 驗收標準

### 基本驗收

- Header 右側有清楚的模式切換按鈕。
- 可在一般民眾與政府單位模式間切換。
- 切換模式不會中斷目前時間、事件、地圖狀態。
- 兩種模式看到的 Header 指標不同。
- 民眾模式不顯示內部 SOP、推理鏈與原始技術 id。
- 政府模式保留現有 AI Decision、SOP、ETE、Timeline。

### 體驗驗收

- 一般民眾在 5 秒內能理解目前是否需要避開某區域。
- 政府單位在 5 秒內能知道最高優先事件與 SOP 觸發原因。
- 民眾模式語氣穩定清楚，不造成過度警示。
- 政府模式資料足夠支援決策與事後稽核。

## 風險與注意事項

1. 不應只用 CSS 隱藏敏感資訊  
   若未來有後端與權限，敏感資料應由 API 層依權限過濾。前端模式切換只適合 demo 或已授權資料環境。

2. 民眾模式不能過度簡化  
   雖然要避免內部細節，但仍要提供可行動資訊，例如替代路線、預估延誤、官方建議。

3. 政府模式不能被民眾文案稀釋  
   政府使用者需要保留原始指標、規則依據與可追溯性。

4. 多語言要依模式調整  
   民眾模式多語言應偏公告與旅客指引，政府模式多語言應偏發布草稿與訊息審核。

5. Demo 與正式產品的權限不同  
   Demo 可以讓使用者切換兩種模式；正式產品應依登入角色限制政府模式。

## 建議優先做法

第一版建議先做「視圖模式」而不是完整權限系統：

1. Header 加 `ViewerModeSwitch`
2. Store 加 `viewerMode`
3. Header 指標依模式調整
4. LeftPanel / RightPanel / BottomBar 先做條件式顯示
5. 建立 public mode 的資料轉譯工具

這樣可以用最小改動快速展示「同一套 AI 城市資料，依使用者身分提供不同資訊層級」的價值，之後再把政府模式接上權限、任務派發與正式公告流程。
