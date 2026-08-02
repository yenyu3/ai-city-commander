import {
  AlertTriangle,
  Building2,
  Bus,
  Check,
  ChevronDown,
  Clock,
  Database,
  Download,
  Hourglass,
  Info,
  Plus,
  Route,
  Send,
  ShieldAlert,
  TrafficCone,
  Train,
  TrendingUp,
  Users,
  X,
  Zap,
} from "lucide-react";
import { useEffect, useState } from "react";

// Traffic Event Level Type
type TrafficLevel = "A" | "B" | "C";

// ETE (Estimated Time of Recovery) Details Structure
interface EteDetails {
  totalMinutes: number;
  baseClearance: number; // Base minutes
  congestionPenalty: number; // Penalty minutes
  formula: string; // Explanation formula
}

// Signal Timing Structure
interface SignalIntersection {
  name: string;
  original: string;
  adjusted: string;
  goal: string;
}

// Inter-agency Action Structure
interface InterlockItem {
  agency: string;
  text: string;
  icon: "train" | "bus" | "shield";
}

// Main Event Payload Type
interface EventData {
  eventId: string;
  sopId: string;
  sopDescription: string;
  eventTitle: string;
  timeUTC8: string;
  trafficLevel: string;
  levelCode: TrafficLevel;
  commandSummary: string;
  ete: EteDetails;
  metrics: {
    flow: string;
    vcRatio: string;
    reasoning: string;
  };
  actionTimeline: Array<{ title: string; desc: string }>;
  rerouting: {
    primary: string;
    primaryDesc: string;
    secondary: string;
    secondaryDesc: string;
    excludedReason: string;
  };
  signalTiming: {
    period: string;
    intersections: SignalIntersection[];
  };
  interlocks: InterlockItem[];
  locations: string[];
}

const MOCK_EVENTS: Record<string, EventData> = {
  "EVT-20260730-001": {
    eventId: "EVT-20260730-001",
    sopId: "SOP-TRAFFIC-038",
    sopDescription:
      "當市區一級主幹道車流飽和度 (V/C) 大於 0.90 且道路容量受阻超過 50% 時，應啟動 A 級緊急交通疏散與跨系統應變程序。",
    eventTitle: "忠孝東路四段 觸發 A 級壅塞",
    timeUTC8: "2026-07-30 14:28",
    trafficLevel: "A級",
    levelCode: "A",
    commandSummary:
      "指揮中心研判，忠孝東路四段飽和度達 0.96，已升級為 A 級壅塞。已通報交控中心啟動「A級長綠燈與緊急疏導時制」，替代道路綠燈配時 +25%，並調度警力淨空路口。（依據 SOP §38）",
    ete: {
      totalMinutes: 89,
      baseClearance: 60,
      congestionPenalty: 29.4,
      formula:
        "base_clearance(Critical)=60 + congestion_penalty=(0.99-0.5)×60=29.4 → ETE=89分鐘",
    },
    metrics: {
      flow: "2,850 pcu/h",
      vcRatio: "0.96 (極度壅塞)",
      reasoning:
        "根據基隆路與忠孝東路口監測點資料，忠孝東路西往東方向飽和度已過 0.96 高位告警值，預估回堵長度達到 1.2 公里。符合啟動 A 級緊急處置規定。",
    },
    actionTimeline: [
      {
        title: "Saturation_Score=0.96 (V/C 飽和度) → A 級壅塞",
        desc: "路側監測器量測車流量 2,850 pcu/h，飽和度達到高告警門檻，即時觸發 A 級緊急應變與管制程序。",
      },
      {
        title: "通報交控中心啟動「A 級長綠燈與動態疏導時制」",
        desc: "針對仁愛路四段、光復南路等主疏散幹道進行動態號誌優化，主要疏散路徑綠燈秒數增加 25%。",
      },
      {
        title: "發送跨系統應變通報 (北捷 / 公車處 / 交通警察大隊)",
        desc: "通知捷運板南線加開空車疏導人潮、公車實施仁愛路彈性改道，並派員警 4 名至路口實施手動現場疏導。",
      },
    ],
    rerouting: {
      primary: "忠孝東路四段 ➔ 光復南路 (南下) ➔ 仁愛路四段 (西向東) ➔ 松仁路",
      primaryDesc:
        "仁愛路線道寬敞容量充裕，AI 評估引導車流改行仁愛路可消化忠孝東路約 40% 之車流。",
      secondary: "忠孝東路 ➔ 建國南路高架 ➔ 市民大道高架 (東向) ➔ 永吉路匝道",
      secondaryDesc: "適於長程越境車流，避開地平面受阻路段。",
      excludedReason:
        "排除 信義路四段：目前信義路捷運施工路段縮減，飽和度已達 0.88，若強行引導匯入將引發區域二次連鎖壅塞。",
    },
    signalTiming: {
      period: "14:30 - 16:30",
      intersections: [
        {
          name: "仁愛路四段與光復南路口",
          original: "50 秒",
          adjusted: "62.5 秒 (+25%)",
          goal: "加速主要疏散替代路徑車流消化速度",
        },
        {
          name: "忠孝東路四段 (事故受阻區)",
          original: "80 秒",
          adjusted: "64 秒 (-20%)",
          goal: "調控瓶頸點車流匯入頻率",
        },
        {
          name: "基隆路一段與松高路口",
          original: "45 秒",
          adjusted: "54 秒 (+20%)",
          goal: "引導車流分流至南北向幹線",
        },
      ],
    },
    interlocks: [
      {
        agency: "臺北捷運公司 (TRTC)",
        text: "板南線市政府站與國父紀念館站加開空車疏導人潮，啟動月台管制。",
        icon: "train",
      },
      {
        agency: "臺北市公車聯營管理處",
        text: "通報行經忠孝東路四段公車彈性改道仁愛路，並於公車亭告示改道資訊。",
        icon: "bus",
      },
      {
        agency: "交通警察大隊 / 信義分局",
        text: "派遣員警 4 名至忠孝/基隆路口與忠孝/光復路口實施現場控號與淨空路口。",
        icon: "shield",
      },
    ],
    locations: ["台北101廣場", "ATT4FUN周邊", "國父紀念館商圈"],
  },
  "EVT-20260730-002": {
    eventId: "EVT-20260730-002",
    sopId: "SOP-TRAFFIC-015",
    sopDescription:
      "場館活動散場或號誌異常造成局部路口延滯時間 > 80 秒，需啟動 B 級號誌連鎖調整及公車疏導。",
    eventTitle: "光復南路 觸發 B 級壅塞",
    timeUTC8: "2026-07-30 14:28",
    trafficLevel: "B級",
    levelCode: "B",
    commandSummary:
      "指揮中心研判，光復南路目前飽和度達 0.85，已升級為 B 級。已通報交控中心啟動長綠燈時制，替代道路綠燈配時 +25%，並調度警力淨空路口。（依據 SOP §15）",
    ete: {
      totalMinutes: 45,
      baseClearance: 30,
      congestionPenalty: 15,
      formula:
        "base_clearance=30 + congestion_penalty=(0.85-0.5)×42.8=15 → ETE=45分鐘",
    },
    metrics: {
      flow: "1,980 pcu/h",
      vcRatio: "0.85 (顯著壅塞)",
      reasoning:
        "光復南路現場車流飽和度達 0.85，路口平均延滯時間達到 85 秒，符合啟動 B 級號誌連鎖調整標準。",
    },
    actionTimeline: [
      {
        title: "Saturation_Score=0.85 → B 級壅塞",
        desc: "監測飽和度達 0.85，啟動 B 級警告程序。",
      },
      {
        title: "通報交控中心啟動「長綠燈時制」",
        desc: "對周邊主要替代幹道實施長綠燈控制方案。",
      },
      {
        title: "替代道路綠燈配時 +25%",
        desc: "擴增替代疏散路徑通行綠燈秒數。",
      },
    ],
    rerouting: {
      primary: "光復南路 (南下) ➔ 仁愛路四段 ➔ 延吉街",
      primaryDesc: "引導車流改行仁愛路與延吉街分流。",
      secondary: "忠孝東路 ➔ 敦化南路",
      secondaryDesc: "長程車流提前改道敦化南路。",
      excludedReason: "排除 信義路口：因號誌時相較為複雜，不宜額外匯入車流。",
    },
    signalTiming: {
      period: "14:30 - 16:00",
      intersections: [
        {
          name: "光復南路與仁愛路口",
          original: "55 秒",
          adjusted: "68.5 秒 (+25%)",
          goal: "促進光復南路南下車流疏導",
        },
      ],
    },
    interlocks: [
      {
        agency: "交通警察大隊 / 大安分局",
        text: "派員警 2 名淨空光復南路口。",
        icon: "shield",
      },
      {
        agency: "臺北市公車聯營管理處",
        text: "發佈公車動態改道資訊。",
        icon: "bus",
      },
    ],
    locations: ["光復南路沿線", "大巨蛋園區周邊"],
  },
  "EVT-20260730-003": {
    eventId: "EVT-20260730-003",
    sopId: "SOP-TRAFFIC-005",
    sopDescription:
      "例行施工或微幅車流波動 (V/C < 0.75)，進行動態號誌秒數微調。",
    eventTitle: "信義路五段 觸發 C 級微幅影響",
    timeUTC8: "2026-07-30 15:00",
    trafficLevel: "C級",
    levelCode: "C",
    commandSummary:
      "指揮中心研判，信義路五段因微型施工飽和度為 0.68，判定為 C 級輕微影響。實施微幅號誌動態調增。（依據 SOP §5）",
    ete: {
      totalMinutes: 20,
      baseClearance: 15,
      congestionPenalty: 5,
      formula: "base_clearance=15 + congestion_penalty=5 → ETE=20分鐘",
    },
    metrics: {
      flow: "1,200 pcu/h",
      vcRatio: "0.68 (正常順暢)",
      reasoning: "施工僅佔用單一車道，流速小幅受限，V/C 為 0.68，屬 C 級狀況。",
    },
    actionTimeline: [
      {
        title: "Saturation_Score=0.68 → C 級影響",
        desc: "微幅波動，無須大規模改道。",
      },
      {
        title: "動態微調信義路號誌 +10%",
        desc: "微幅增長綠燈秒數消化施工車流。",
      },
    ],
    rerouting: {
      primary: "維持原路段行駛，建議提早變換車道",
      primaryDesc: "車流無須改道。",
      secondary: "松德路 ➔ 松仁路",
      secondaryDesc: "區域性小型繞行建議。",
      excludedReason: "無特別排除路段。",
    },
    signalTiming: {
      period: "15:00 - 17:00",
      intersections: [
        {
          name: "信義路五段與松智路口",
          original: "45 秒",
          adjusted: "49.5 秒 (+10%)",
          goal: "紓解施工縮減車道微幅回堵",
        },
      ],
    },
    interlocks: [
      {
        agency: "工程施工單位",
        text: "要求施工單位加強路口警示告示。",
        icon: "shield",
      },
    ],
    locations: ["信義路五段施工點"],
  },
};

export default function App() {
  const [selectedEventId, setSelectedEventId] =
    useState<string>("EVT-20260730-001");
  const [activeTab, setActiveTab] = useState<"decision" | "overview">(
    "decision",
  );
  const [isAlertModalOpen, setIsAlertModalOpen] = useState<boolean>(false);
  const [toastMessage, setToastMessage] = useState<{
    text: string;
    type: "info" | "success" | "error";
  } | null>(null);

  // Multi-language Alert Modal States
  const [selectedLocation, setSelectedLocation] = useState<string>("");
  const [selectedLangs, setSelectedLangs] = useState<{
    zh: boolean;
    en: boolean;
    ja: boolean;
    ko: boolean;
  }>({
    zh: true,
    en: true,
    ja: true,
    ko: true,
  });

  const currentData = MOCK_EVENTS[selectedEventId];

  // Load html2pdf script dynamically if missing
  useEffect(() => {
    if (!window.html2pdf) {
      const script = document.createElement("script");
      script.src =
        "https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js";
      script.async = true;
      document.body.appendChild(script);
    }
  }, []);

  // Update modal location default when current event changes
  useEffect(() => {
    if (currentData.locations && currentData.locations.length > 0) {
      setSelectedLocation(currentData.locations[0]);
    }
  }, [selectedEventId]);

  const showToast = (
    text: string,
    type: "info" | "success" | "error" = "info",
  ) => {
    setToastMessage({ text, type });
    setTimeout(() => {
      setToastMessage(null);
    }, 3200);
  };

  const handleGeneratePDF = () => {
    showToast("正在生成「交控中心建議書」PDF 檔案...", "info");

    const pdfTemplateEl = document.getElementById("pdf-export-template");
    if (!pdfTemplateEl) return;

    pdfTemplateEl.style.display = "block";

    const opt = {
      margin: [10, 10, 10, 10],
      filename: `交控中心建議書_${currentData.eventId}.pdf`,
      image: { type: "jpeg", quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true, logging: false },
      jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
    };

    if (window.html2pdf) {
      window
        .html2pdf()
        .set(opt)
        .from(pdfTemplateEl)
        .save()
        .then(() => {
          pdfTemplateEl.style.display = "none";
          showToast("「交控中心建議書」PDF 匯出成功！", "success");
        })
        .catch((err: unknown) => {
          pdfTemplateEl.style.display = "none";
          showToast("PDF 生成失敗，請再試一次。", "error");
          console.error(err);
        });
    } else {
      setTimeout(() => {
        pdfTemplateEl.style.display = "none";
        showToast("PDF 元件載入中，請稍後再試！", "error");
      }, 1000);
    }
  };

  const handleConfirmPublish = () => {
    setIsAlertModalOpen(false);
    showToast(
      `已成功對 [${selectedLocation}] 發布四語交通警示推播！`,
      "success",
    );
  };

  const activeLangCount = Object.values(selectedLangs).filter(Boolean).length;

  return (
    <div className="min-h-screen bg-[#f3f4f6] text-slate-800 font-sans antialiased pb-12 selection:bg-slate-900 selection:text-white">
      {/* Toast Notification Banner */}
      {toastMessage && (
        <div className="fixed bottom-6 right-6 z-50 animate-bounce">
          <div
            className={`flex items-center gap-2.5 px-4 py-3 rounded-xl border shadow-xl text-xs font-bold text-white transition-all ${
              toastMessage.type === "success"
                ? "bg-emerald-800 border-emerald-700"
                : toastMessage.type === "error"
                  ? "bg-red-800 border-red-700"
                  : "bg-slate-900 border-slate-800"
            }`}
          >
            <Info className="w-4 h-4 text-emerald-400" />
            <span>{toastMessage.text}</span>
          </div>
        </div>
      )}

      {/* Header Navigation */}
      <header className="bg-white border-b border-slate-200/80 sticky top-0 z-40 shadow-sm">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-14">
            {/* Logo */}
            <div className="flex items-center gap-2 font-bold text-slate-900 text-lg">
              <Building2 className="w-5 h-5 text-slate-700" />
              <span>城市情報室</span>
            </div>

            {/* Right Header Actions */}
            <div className="flex items-center gap-3">
              {/* API Event Selector */}
              <div className="hidden sm:flex items-center bg-slate-100 rounded-lg px-2.5 py-1 border border-slate-200">
                <span className="text-xs text-slate-500 font-medium mr-1.5 flex items-center gap-1">
                  <Database className="w-3.5 h-3.5 text-slate-400" /> 事件 API
                  模擬:
                </span>
                <select
                  value={selectedEventId}
                  onChange={(e) => {
                    setSelectedEventId(e.target.value);
                    showToast(`已切換至事件 ${e.target.value}`, "info");
                  }}
                  className="bg-transparent text-xs font-bold text-slate-800 border-none focus:ring-0 focus:outline-none cursor-pointer"
                >
                  <option value="EVT-20260730-001">
                    忠孝東路多車連環追撞 (A 級)
                  </option>
                  <option value="EVT-20260730-002">
                    光復南路 觸發 B 級壅塞 (B 級)
                  </option>
                  <option value="EVT-20260730-003">
                    信義路道路施工號誌調整 (C 級)
                  </option>
                </select>
              </div>

              {/* PDF Export Button */}
              <button
                onClick={handleGeneratePDF}
                title="下載交控中心建議書 (PDF)"
                className="w-9 h-9 rounded-full bg-slate-900 hover:bg-slate-800 text-white flex items-center justify-center transition shadow-sm active:scale-95"
              >
                <Download className="w-4 h-4" />
              </button>

              {/* Quick Add Button */}
              <button
                onClick={() =>
                  showToast("已將此事件紀錄加入情報紀錄冊", "info")
                }
                title="新增紀錄"
                className="w-9 h-9 rounded-full bg-slate-100 hover:bg-slate-200 text-slate-700 flex items-center justify-center transition border border-slate-200 active:scale-95"
              >
                <Plus className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Sub Navigation Tabs */}
          <div className="flex items-center gap-8 border-t border-slate-100 mt-1 pt-3 text-sm font-bold">
            <button
              onClick={() => setActiveTab("decision")}
              className={`pb-2.5 border-b-2 tracking-wide transition ${
                activeTab === "decision"
                  ? "border-slate-900 text-slate-900"
                  : "border-transparent text-slate-400 hover:text-slate-600"
              }`}
            >
              AI 決策
            </button>
            <button
              onClick={() => {
                setActiveTab("overview");
                showToast("情境總覽模式切換中...", "info");
              }}
              className={`pb-2.5 border-b-2 tracking-wide transition ${
                activeTab === "overview"
                  ? "border-slate-900 text-slate-900"
                  : "border-transparent text-slate-400 hover:text-slate-600"
              }`}
            >
              情境總覽
            </button>
          </div>
        </div>
      </header>

      {/* Main Workspace */}
      <main className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
        {/* 1. AI 決策摘要卡片 (Primary Summary Card) */}
        <section className="bg-white rounded-2xl border border-slate-200/90 shadow-sm p-6 sm:p-8 space-y-5">
          <div className="flex items-center justify-between">
            <div className="text-xs font-bold text-slate-400 tracking-wide">
              決策摘要
            </div>
            <button
              onClick={() => setIsAlertModalOpen(true)}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold rounded-xl shadow-sm transition active:scale-95"
            >
              <Send className="w-3.5 h-3.5" />
              <span>發布警示</span>
            </button>
          </div>

          {/* Event Title */}
          <h1 className="text-2xl sm:text-3xl font-extrabold text-slate-900 tracking-tight leading-snug">
            {currentData.eventTitle}
          </h1>

          {/* Time & Tags */}
          <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500 font-medium">
            <div className="flex items-center gap-1.5 bg-slate-50 px-2.5 py-1 rounded-md border border-slate-200/60 font-mono">
              <Clock className="w-3.5 h-3.5 text-slate-400" />
              <span>{currentData.timeUTC8}</span>
            </div>

            <span
              className={`px-2.5 py-1 rounded-md font-bold border ${
                currentData.levelCode === "A"
                  ? "bg-red-50 text-red-600 border-red-100"
                  : currentData.levelCode === "B"
                    ? "bg-amber-50 text-amber-600 border-amber-100"
                    : "bg-emerald-50 text-emerald-600 border-emerald-100"
              }`}
            >
              壅塞分級
            </span>

            <span className="text-slate-300">|</span>
            <span className="font-mono text-slate-400">
              SOP 編號:{" "}
              <strong className="text-slate-700">{currentData.sopId}</strong>
            </span>
          </div>

          {/* Traffic Level Callout */}
          <div className="pt-2 pb-1 flex items-baseline gap-3">
            <span
              className={`text-5xl sm:text-6xl font-black tracking-tight ${
                currentData.levelCode === "A"
                  ? "text-red-600"
                  : currentData.levelCode === "B"
                    ? "text-amber-500"
                    : "text-emerald-600"
              }`}
            >
              {currentData.trafficLevel}
            </span>
            <span className="text-sm font-bold text-slate-400 tracking-wide">
              目前壅塞分級
            </span>
          </div>

          {}
          {/* PROMINENT ETE Breakdown Card (Matching screenshot style) */}
          <div className="bg-slate-50/90 rounded-2xl border border-slate-200/80 p-5 space-y-4">
            <div className="text-xs font-bold text-slate-700 tracking-wide flex items-center justify-between">
              <span>預計恢復時間</span>
              <span className="text-[11px] font-normal text-slate-400 font-mono">
                Estimated Time of Clearance (ETE)
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-12 gap-6 items-center">
              {/* Left: Donut SVG Progress Circle */}
              <div className="md:col-span-5 flex items-center justify-center relative py-2">
                <div className="relative w-36 h-36 flex items-center justify-center">
                  <svg
                    className="w-full h-full transform -rotate-90"
                    viewBox="0 0 36 36"
                  >
                    {/* Background Ring */}
                    <path
                      className="text-slate-200"
                      strokeWidth="3.8"
                      stroke="currentColor"
                      fill="none"
                      d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                    />
                    {/* Base clearance arc (Teal) */}
                    <path
                      className="text-cyan-700"
                      strokeDasharray={`${(currentData.ete.baseClearance / currentData.ete.totalMinutes) * 100}, 100`}
                      strokeWidth="3.8"
                      strokeLinecap="round"
                      stroke="currentColor"
                      fill="none"
                      d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                    />
                    {/* Congestion Penalty arc (Amber/Bronze) */}
                    <path
                      className="text-amber-600"
                      strokeDasharray={`${(currentData.ete.congestionPenalty / currentData.ete.totalMinutes) * 100}, 100`}
                      strokeDashoffset={`-${(currentData.ete.baseClearance / currentData.ete.totalMinutes) * 100}`}
                      strokeWidth="3.8"
                      strokeLinecap="round"
                      stroke="currentColor"
                      fill="none"
                      d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                    />
                  </svg>

                  {/* Center Text */}
                  <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
                    <Hourglass className="w-4 h-4 text-slate-400 mb-0.5" />
                    <span className="text-3xl font-black text-slate-900 leading-none">
                      {currentData.ete.totalMinutes}
                    </span>
                    <span className="text-[11px] text-slate-500 font-bold mt-1">
                      分鐘
                    </span>
                  </div>
                </div>
              </div>

              {/* Right: Breakdown Detail Sub-cards */}
              <div className="md:col-span-7 space-y-2.5">
                {/* Base Clearance Bar */}
                <div className="bg-white rounded-xl p-3.5 border border-slate-200/70 flex items-center justify-between shadow-2xs">
                  <div className="flex items-center gap-2.5">
                    <div className="w-1.5 h-6 rounded-full bg-cyan-700"></div>
                    <span className="text-xs font-bold text-slate-700">
                      基礎清空
                    </span>
                  </div>
                  <div className="text-right">
                    <span className="text-base font-black text-slate-900 font-mono">
                      {currentData.ete.baseClearance}
                    </span>
                    <span className="text-[10px] text-slate-400 ml-1">
                      分鐘
                    </span>
                  </div>
                </div>

                {/* Congestion Penalty Bar */}
                <div className="bg-white rounded-xl p-3.5 border border-slate-200/70 flex items-center justify-between shadow-2xs">
                  <div className="flex items-center gap-2.5">
                    <div className="w-1.5 h-6 rounded-full bg-amber-600"></div>
                    <span className="text-xs font-bold text-slate-700">
                      壅塞加成
                    </span>
                  </div>
                  <div className="text-right">
                    <span className="text-base font-black text-slate-900 font-mono">
                      {currentData.ete.congestionPenalty}
                    </span>
                    <span className="text-[10px] text-slate-400 ml-1">
                      分鐘
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Formula Pill Badge (Matching image formula display) */}
            <div className="pt-1">
              <div className="inline-flex items-center gap-1.5 bg-slate-200/70 text-slate-600 px-3 py-1.5 rounded-lg text-[11px] font-mono leading-tight max-w-full overflow-x-auto">
                <span className="bg-slate-300 text-slate-800 font-bold px-1.5 py-0.5 rounded text-[10px]">
                  依據
                </span>
                <span>{currentData.ete.formula}</span>
              </div>
            </div>
          </div>

          {/* Command Paragraph */}
          <p className="text-slate-600 text-sm leading-relaxed font-normal pt-1">
            {currentData.commandSummary}
          </p>

          {/* Quick Filter Buttons */}
          <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-100">
            <a
              href="#sec-actions"
              className="px-3.5 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs flex items-center gap-1 transition"
            >
              <span>建議行動</span>{" "}
              <ChevronDown className="w-3 h-3 text-slate-400" />
            </a>
            <a
              href="#sec-reasoning"
              className="px-3.5 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs flex items-center gap-1 transition"
            >
              <span>推理與數據依據</span>{" "}
              <ChevronDown className="w-3 h-3 text-slate-400" />
            </a>
            <a
              href="#sec-reroute"
              className="px-3.5 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs flex items-center gap-1 transition"
            >
              <span>替代路徑建議</span>{" "}
              <ChevronDown className="w-3 h-3 text-slate-400" />
            </a>
            <a
              href="#sec-signals"
              className="px-3.5 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs flex items-center gap-1 transition"
            >
              <span>號誌與跨系統聯動</span>{" "}
              <ChevronDown className="w-3 h-3 text-slate-400" />
            </a>
          </div>
        </section>

        {/* 2. 建議行動 Timeline */}
        <section
          id="sec-actions"
          className="bg-white rounded-2xl border border-slate-200/90 shadow-sm p-6 sm:p-8 space-y-5"
        >
          <h2 className="text-base font-extrabold text-slate-900 tracking-tight flex items-center justify-between">
            <span>建議行動</span>
            <span className="text-xs text-slate-400 font-normal">
              AI Recommended Action Steps
            </span>
          </h2>

          <div className="relative border-l-2 border-slate-100 ml-3 pl-6 space-y-6">
            {currentData.actionTimeline.map((step, idx) => (
              <div key={idx} className="relative group">
                <span className="absolute -left-[35px] top-0 w-7 h-7 rounded-full bg-white border-2 border-slate-300 text-slate-800 text-xs font-extrabold flex items-center justify-center shadow-sm">
                  {idx + 1}
                </span>
                <div className="font-bold text-slate-900 text-sm">
                  {step.title}
                </div>
                <p className="text-xs text-slate-500 mt-1 leading-relaxed">
                  {step.desc}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* 3. 數據依據 (Metrics Grid) */}
        <section
          id="sec-reasoning"
          className="bg-white rounded-2xl border border-slate-200/90 shadow-sm p-6 sm:p-8 space-y-4"
        >
          <h2 className="text-base font-extrabold text-slate-900 tracking-tight flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-slate-600" />
            <span>交通分級判定依據與關鍵數據</span>
          </h2>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-2">
            <div className="bg-slate-50 p-4 rounded-xl border border-slate-200/70">
              <div className="text-xs text-slate-400 font-semibold">
                即時車流量
              </div>
              <div className="text-2xl font-black text-slate-900 font-mono mt-1">
                {currentData.metrics.flow.split(" ")[0]}{" "}
                <span className="text-xs font-normal text-slate-500">
                  pcu/h
                </span>
              </div>
              <div className="text-[11px] text-slate-400 mt-1">
                常態基準: 1,800 pcu/h
              </div>
            </div>

            <div className="bg-slate-50 p-4 rounded-xl border border-slate-200/70">
              <div className="text-xs text-slate-400 font-semibold">
                道路飽和度 (V/C)
              </div>
              <div className="text-2xl font-black text-red-600 font-mono mt-1">
                {currentData.metrics.vcRatio}
              </div>
              <div className="text-[11px] text-slate-400 mt-1">
                A級判定門檻: &gt; 0.90
              </div>
            </div>

            <div className="bg-slate-50 p-4 rounded-xl border border-slate-200/70">
              <div className="text-xs text-slate-400 font-semibold">
                觸發依據 SOP
              </div>
              <div className="text-sm font-bold text-slate-800 mt-2 font-mono">
                {currentData.sopId}
              </div>
              <div className="text-[11px] text-slate-400 mt-1">
                一級主幹道容量受阻 &gt; 50%
              </div>
            </div>
          </div>

          <div className="bg-slate-50/80 p-4 rounded-xl border border-slate-200/70 text-xs leading-relaxed text-slate-600 space-y-1">
            <div className="font-bold text-slate-800 flex items-center gap-1.5">
              <Info className="w-3.5 h-3.5 text-slate-500" /> AI 推理判斷說明：
            </div>
            <p>{currentData.metrics.reasoning}</p>
          </div>
        </section>

        {/* 4. 替代路徑建議 */}
        <section
          id="sec-reroute"
          className="bg-white rounded-2xl border border-slate-200/90 shadow-sm p-6 sm:p-8 space-y-4"
        >
          <h2 className="text-base font-extrabold text-slate-900 tracking-tight flex items-center gap-2">
            <Route className="w-4 h-4 text-slate-600" />
            <span>替代路徑疏散規劃 (Rerouting Plan)</span>
          </h2>

          <div className="space-y-3 pt-1">
            {/* Primary Route */}
            <div className="p-4 rounded-xl bg-emerald-50/60 border border-emerald-200/80 flex gap-4">
              <div className="shrink-0 flex items-center justify-center w-10 h-10 rounded-xl bg-emerald-100 border border-emerald-200 self-center">
                <Check className="w-5 h-5 text-emerald-600" />
              </div>
              <div className="flex-1 space-y-1">
                <div className="flex items-center justify-between text-xs font-bold text-emerald-800">
                  <span>主要疏散路徑 (Primary)</span>
                  <span className="font-mono text-[11px] bg-emerald-100 px-2 py-0.5 rounded text-emerald-800">
                    容量預期分流 40%
                  </span>
                </div>
                <div className="text-sm font-bold text-slate-900">
                  {currentData.rerouting.primary}
                </div>
                <p className="text-xs text-slate-600">
                  {currentData.rerouting.primaryDesc}
                </p>
              </div>
            </div>

            {/* Secondary Route */}
            <div className="p-4 rounded-xl bg-slate-50 border border-slate-200/80 flex gap-4">
              <div className="shrink-0 flex items-center justify-center w-10 h-10 rounded-xl bg-slate-200 border border-slate-300 self-center">
                <Zap className="w-5 h-5 text-slate-500" />
              </div>
              <div className="flex-1 space-y-1">
                <div className="flex items-center justify-between text-xs font-bold text-slate-700">
                  <span>次要替代路徑 (Secondary)</span>
                  <span className="font-mono text-[11px] text-slate-500">
                    適於長程越境車流
                  </span>
                </div>
                <div className="text-sm font-bold text-slate-800">
                  {currentData.rerouting.secondary}
                </div>
                <p className="text-xs text-slate-500">
                  {currentData.rerouting.secondaryDesc}
                </p>
              </div>
            </div>

            {/* Excluded Reason */}
            <div className="p-3.5 rounded-xl bg-red-50/50 border border-red-100 flex gap-4">
              <div className="shrink-0 flex items-center justify-center w-10 h-10 rounded-xl bg-red-100 border border-red-200 self-center">
                <AlertTriangle className="w-5 h-5 text-red-600" />
              </div>
              <div className="flex-1 space-y-1">
                <span className="font-bold text-red-700 text-xs block">排除候選路段說明：</span>
                <p className="text-xs text-slate-600">{currentData.rerouting.excludedReason}</p>
              </div>
            </div>
          </div>
        </section>

        {/* 5. 號誌與跨系統聯動 */}
        <section
          id="sec-signals"
          className="bg-white rounded-2xl border border-slate-200/90 shadow-sm p-6 sm:p-8 space-y-6"
        >
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <h2 className="text-base font-extrabold text-slate-900 tracking-tight flex items-center gap-2">
                <TrafficCone className="w-4 h-4 text-slate-600" />
                <span>號誌動態配時調整建議</span>
              </h2>
              <span className="text-xs font-mono text-slate-500 bg-slate-100 px-2.5 py-1 rounded-md border border-slate-200">
                調整時段:{" "}
                <strong className="text-slate-800">14:30 到 16:30</strong>
              </span>
            </div>

            <div className="overflow-x-auto border border-slate-200 rounded-xl">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-slate-50 text-slate-500 font-bold border-b border-slate-200">
                    <th className="p-3">受影響路口 / 路段</th>
                    <th className="p-3">原綠燈時相</th>
                    <th className="p-3">建議調整配時</th>
                    <th className="p-3">預期優化目標</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-slate-700 font-medium">
                  {currentData.signalTiming.intersections.map((row, idx) => (
                    <tr key={idx} className="hover:bg-slate-50/80 transition">
                      <td className="p-3 font-bold text-slate-900">
                        {row.name}
                      </td>
                      <td className="p-3 font-mono text-slate-500">
                        {row.original}
                      </td>
                      <td className="p-3 font-mono font-bold text-emerald-600">
                        {row.adjusted}
                      </td>
                      <td className="p-3 text-slate-600">{row.goal}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="space-y-3 pt-3 border-t border-slate-100">
            <h3 className="text-sm font-bold text-slate-900 flex items-center justify-between">
              <span className="flex items-center gap-2">
                <Users className="w-4 h-4 text-slate-600" /> 跨系統聯動請求
                (Inter-agency Actions)
              </span>
              <span className="text-xs text-slate-500 bg-slate-100 px-2 py-0.5 rounded font-normal">
                已觸發 {currentData.interlocks.length} 項通報
              </span>
            </h3>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {currentData.interlocks.map((item, idx) => (
                <div
                  key={idx}
                  className="p-3.5 bg-slate-50 rounded-xl border border-slate-200/80 space-y-1"
                >
                  <div className="text-xs font-bold text-slate-900 flex items-center gap-1.5">
                    {item.icon === "train" && (
                      <Train className="w-3.5 h-3.5 text-slate-600" />
                    )}
                    {item.icon === "bus" && (
                      <Bus className="w-3.5 h-3.5 text-slate-600" />
                    )}
                    {item.icon === "shield" && (
                      <ShieldAlert className="w-3.5 h-3.5 text-slate-600" />
                    )}
                    <span>{item.agency}</span>
                  </div>
                  <p className="text-xs text-slate-500 leading-relaxed">
                    {item.text}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>
      </main>

      {}
      {/* =================================================================== */}
      {/* MULTI-LANGUAGE ALERT MODAL (多語警示預覽 - Matching Screenshot 2)   */}
      {/* =================================================================== */}
      {isAlertModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-xs p-4">
          <div className="bg-slate-100 w-full max-w-xl rounded-2xl shadow-2xl border border-slate-200 overflow-hidden text-slate-900 animate-in fade-in zoom-in duration-200">
            {/* Modal Header */}
            <div className="p-5 border-b border-slate-200/80 flex items-center justify-between bg-slate-100">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <h3 className="text-base font-extrabold text-slate-900">
                    多語警示預覽
                  </h3>
                  <span className="text-[11px] font-bold bg-slate-200 text-slate-700 px-2 py-0.5 rounded-full">
                    漫遊比例 45%
                  </span>
                  <span className="text-[11px] font-bold bg-slate-200 text-slate-700 px-2 py-0.5 rounded-full">
                    已選語言 {activeLangCount}/4
                  </span>
                </div>
              </div>

              <button
                onClick={() => setIsAlertModalOpen(false)}
                className="w-8 h-8 rounded-full bg-slate-200 hover:bg-slate-300 text-slate-600 flex items-center justify-center transition"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-5 space-y-4 max-h-[75vh] overflow-y-auto">
              {/* Location Select Pills */}
              <div className="flex flex-wrap items-center gap-2">
                {currentData.locations.map((loc) => (
                  <button
                    key={loc}
                    onClick={() => setSelectedLocation(loc)}
                    className={`px-3.5 py-1.5 rounded-xl text-xs font-bold transition border ${
                      selectedLocation === loc
                        ? "bg-slate-900 text-white border-slate-900 shadow-xs"
                        : "bg-white text-slate-700 border-slate-200 hover:bg-slate-200"
                    }`}
                  >
                    {loc}
                  </button>
                ))}
              </div>

              {/* Language Selection Buttons */}
              <div className="grid grid-cols-4 gap-2 bg-slate-200/70 p-1.5 rounded-xl text-xs font-bold">
                {[
                  { key: "zh", label: "中文" },
                  { key: "en", label: "EN" },
                  { key: "ja", label: "日本語" },
                  { key: "ko", label: "韓國語" },
                ].map((lang) => {
                  const isChecked =
                    selectedLangs[lang.key as keyof typeof selectedLangs];
                  return (
                    <button
                      key={lang.key}
                      onClick={() =>
                        setSelectedLangs((prev) => ({
                          ...prev,
                          [lang.key]: !isChecked,
                        }))
                      }
                      className={`py-2 px-2 rounded-lg flex items-center justify-center gap-1 transition ${
                        isChecked
                          ? "bg-white text-slate-900 shadow-xs"
                          : "text-slate-400 hover:text-slate-600"
                      }`}
                    >
                      {isChecked && (
                        <Check className="w-3.5 h-3.5 text-slate-800" />
                      )}
                      <span>{lang.label}</span>
                    </button>
                  );
                })}
              </div>

              {/* Preview Cards Container */}
              <div className="bg-white rounded-xl border border-slate-200 overflow-hidden divide-y divide-slate-100">
                <div className="px-4 py-2 bg-slate-50 flex items-center justify-between text-xs font-bold text-slate-500 border-b border-slate-200">
                  <span>發布通知</span>
                  <span className="text-slate-700">{selectedLocation}</span>
                </div>

                {/* Chinese */}
                {selectedLangs.zh && (
                  <div className="p-4 flex gap-4 text-xs items-start">
                    <span className="font-bold text-slate-400 w-12 shrink-0 pt-0.5">
                      中文
                    </span>
                    <p className="text-slate-800 font-medium leading-relaxed">
                      【交通壅塞提醒】{selectedLocation}
                      周邊交通壅塞，預計恢復時間約{" "}
                      {currentData.ete.totalMinutes}分鐘，請提前規劃行程。
                    </p>
                  </div>
                )}

                {/* English */}
                {selectedLangs.en && (
                  <div className="p-4 flex gap-4 text-xs items-start">
                    <span className="font-bold text-slate-400 w-12 shrink-0 pt-0.5">
                      EN
                    </span>
                    <p className="text-slate-800 font-medium leading-relaxed">
                      [Traffic Alert] Congestion near {selectedLocation}.
                      Estimated clearance ~{currentData.ete.totalMinutes} min.
                      Please plan ahead.
                    </p>
                  </div>
                )}

                {/* Japanese */}
                {selectedLangs.ja && (
                  <div className="p-4 flex gap-4 text-xs items-start">
                    <span className="font-bold text-slate-400 w-12 shrink-0 pt-0.5">
                      日本語
                    </span>
                    <p className="text-slate-800 font-medium leading-relaxed">
                      【交通渋滞のお知らせ】{selectedLocation}
                      周辺で渋滞が発生しています。復旧まで約
                      {currentData.ete.totalMinutes}分の見込みです。
                    </p>
                  </div>
                )}

                {/* Korean */}
                {selectedLangs.ko && (
                  <div className="p-4 flex gap-4 text-xs items-start">
                    <span className="font-bold text-slate-400 w-12 shrink-0 pt-0.5">
                      韓國語
                    </span>
                    <p className="text-slate-800 font-medium leading-relaxed">
                      [교통 혼잡 안내] {selectedLocation} 부근 혼잡 발생. 예상
                      복구 시간 약 {currentData.ete.totalMinutes}분입니다.
                    </p>
                  </div>
                )}
              </div>
            </div>

            {/* Modal Footer */}
            <div className="p-4 bg-slate-100 border-t border-slate-200/80 flex items-center justify-end gap-3">
              <button
                onClick={() => setIsAlertModalOpen(false)}
                className="px-4 py-2 rounded-xl bg-slate-200 hover:bg-slate-300 text-slate-700 text-xs font-bold transition"
              >
                取消
              </button>
              <button
                onClick={handleConfirmPublish}
                className="px-4 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold flex items-center gap-1.5 transition active:scale-95 shadow-xs"
              >
                <Send className="w-3.5 h-3.5" />
                <span>確認發布</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {}
      {/* =================================================================== */}
      {/* HIDDEN PDF TEMPLATE (交控中心建議書)                                  */}
      {/* =================================================================== */}
      <div
        id="pdf-export-template"
        style={{ display: "none" }}
        className="p-8 bg-white text-slate-900 w-[794px] min-h-[1123px] text-xs leading-normal font-sans"
      >
        {/* PDF Header */}
        <div className="border-b-2 border-slate-900 pb-4 mb-5 flex justify-between items-end">
          <div>
            <div className="text-[11px] font-bold text-slate-600 tracking-wider">
              臺北市政府交通局 交通管制工程處
            </div>
            <h1 className="text-2xl font-black text-slate-900 tracking-tight mt-1">
              交控中心建議書
            </h1>
            <div className="text-[10px] text-slate-500 font-mono mt-0.5">
              AI Traffic Decision System Official Proposal
            </div>
          </div>
          <div className="text-right text-[10px] font-mono space-y-0.5 text-slate-600">
            <div>
              <strong>事件編號:</strong> <span>{currentData.eventId}</span>
            </div>
            <div>
              <strong>列印時間:</strong>{" "}
              <span>{new Date().toLocaleString("zh-TW")}</span>
            </div>
            <div>
              <strong>機密等級:</strong> 內部公務件
            </div>
          </div>
        </div>

        {/* Summary Highlight Banner */}
        <div className="bg-slate-50 border border-slate-200 rounded-lg p-3.5 mb-5 grid grid-cols-2 gap-4 text-xs">
          <div>
            <span className="text-slate-500 font-bold block">
              事件名稱與地點：
            </span>
            <span className="text-sm font-extrabold text-slate-900">
              {currentData.eventTitle}
            </span>
          </div>
          <div>
            <span className="text-slate-500 font-bold block">
              時間與交通分級：
            </span>
            <span className="font-mono text-slate-800">
              {currentData.timeUTC8}
            </span>
            <span className="ml-2 font-black text-red-600 text-sm">
              [{currentData.trafficLevel}]
            </span>
          </div>
          <div className="col-span-2 border-t border-slate-200/60 pt-2 flex items-center justify-between">
            <div>
              <span className="text-slate-500 font-bold inline-block mr-1">
                預計恢復時間 (ETE)：
              </span>
              <span className="font-mono font-bold text-slate-900">
                {currentData.ete.totalMinutes} 分鐘 (基礎{" "}
                {currentData.ete.baseClearance}m + 壅塞{" "}
                {currentData.ete.congestionPenalty}m)
              </span>
            </div>
          </div>
        </div>

        {/* Content Sections */}
        <div className="space-y-5 leading-relaxed text-slate-800">
          {/* Section 1 */}
          <section className="space-y-1.5">
            <h2 className="text-xs font-extrabold border-l-4 border-slate-900 pl-2 text-slate-900 uppercase">
              一、事件辨識與交通分級判定依據
            </h2>
            <div className="pl-3 space-y-1">
              <p>
                <strong>1.1 依據 SOP 條款：</strong>{" "}
                <span>
                  {currentData.sopId} ({currentData.sopDescription})
                </span>
              </p>
              <p>
                <strong>1.2 現場監測數據：</strong> 車流量為{" "}
                <span className="font-bold font-mono">
                  {currentData.metrics.flow}
                </span>
                ，飽和度 (V/C) 為{" "}
                <span className="font-bold font-mono text-red-600">
                  {currentData.metrics.vcRatio}
                </span>
                。
              </p>
              <p>
                <strong>1.3 預估恢復算式：</strong>{" "}
                <span className="font-mono text-slate-700">
                  {currentData.ete.formula}
                </span>
              </p>
              <p>
                <strong>1.4 判定理由說明：</strong>{" "}
                <span>{currentData.metrics.reasoning}</span>
              </p>
            </div>
          </section>

          {/* Section 2 */}
          <section className="space-y-1.5">
            <h2 className="text-xs font-extrabold border-l-4 border-slate-900 pl-2 text-slate-900 uppercase">
              二、替代路徑與疏散導引方案
            </h2>
            <div className="pl-3 space-y-1">
              <p>
                <strong>2.1 主要疏散路徑：</strong>{" "}
                <span className="font-bold">
                  {currentData.rerouting.primary}
                </span>
              </p>
              <p>
                <strong>2.2 次要替代路徑：</strong>{" "}
                <span>{currentData.rerouting.secondary}</span>
              </p>
              <p>
                <strong>2.3 排除候選路段理由：</strong>{" "}
                <span>{currentData.rerouting.excludedReason}</span>
              </p>
            </div>
          </section>

          {/* Section 3 */}
          <section className="space-y-1.5">
            <h2 className="text-xs font-extrabold border-l-4 border-slate-900 pl-2 text-slate-900 uppercase">
              三、路段號誌動態調整細節
            </h2>
            <div className="pl-3 space-y-1.5">
              <p>
                <strong>調整實施時段：</strong>{" "}
                <span>{currentData.signalTiming.period}</span>
              </p>
              <table className="w-full border-collapse border border-slate-300 text-[10px] text-left">
                <thead>
                  <tr className="bg-slate-100 font-bold border-b border-slate-300">
                    <th className="p-1.5 border-r border-slate-300">
                      受影響路段
                    </th>
                    <th className="p-1.5 border-r border-slate-300">原綠燈</th>
                    <th className="p-1.5 border-r border-slate-300">
                      建議調整
                    </th>
                    <th className="p-1.5">目的</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {currentData.signalTiming.intersections.map((row, idx) => (
                    <tr key={idx}>
                      <td className="p-1.5 border-r border-slate-300 font-bold">
                        {row.name}
                      </td>
                      <td className="p-1.5 border-r border-slate-300 font-mono text-slate-600">
                        {row.original}
                      </td>
                      <td className="p-1.5 border-r border-slate-300 font-mono font-bold text-emerald-700">
                        {row.adjusted}
                      </td>
                      <td className="p-1.5 text-slate-700">{row.goal}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* Section 4 */}
          <section className="space-y-1.5">
            <h2 className="text-xs font-extrabold border-l-4 border-slate-900 pl-2 text-slate-900 uppercase">
              四、跨單位應變聯動與支援請求
            </h2>
            <div className="pl-3 space-y-1 text-[11px]">
              {currentData.interlocks.map((item, idx) => (
                <p key={idx}>
                  <strong>• {item.agency}：</strong> {item.text}
                </p>
              ))}
            </div>
          </section>
        </div>

        {/* PDF Signature Footer */}
        <div className="mt-14 pt-6 border-t border-slate-300 grid grid-cols-3 gap-4 text-xs text-center text-slate-700">
          <div>
            <div className="font-bold text-slate-900 mb-8">AI 決策系統運算</div>
            <div className="border-b border-slate-400 mx-6 pb-1 text-[10px] text-slate-400">
              （系統自動簽核）
            </div>
          </div>
          <div>
            <div className="font-bold text-slate-900 mb-8">值班管制員簽章</div>
            <div className="border-b border-slate-400 mx-6 pb-1 text-[10px] text-slate-400">
              （簽章區）
            </div>
          </div>
          <div>
            <div className="font-bold text-slate-900 mb-8">
              交控中心主任核定
            </div>
            <div className="border-b border-slate-400 mx-6 pb-1 text-[10px] text-slate-400">
              （簽章區）
            </div>
          </div>
        </div>

        <div className="mt-8 text-center text-[9px] text-slate-400 border-t border-slate-100 pt-3">
          本建議書由臺北市交通控制中心 AI 智慧決策系統產出，供內部應變指揮參考。
        </div>
      </div>
    </div>
  );
}
