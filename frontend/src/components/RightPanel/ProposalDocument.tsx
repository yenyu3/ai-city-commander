import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useAppStore } from "../../store/appStore";
import { opsCoordinationAdapter, type OpsCoordinationPlan } from "../../services/opsCoordinationAdapter";
import type { AlertRecord } from "../../types";
import { ALERT_KIND_LABEL } from "../../utils/alertLabels";
import { formatDisplayTimestamp } from "../../utils/timeUtils";
import { pick, useLanguage } from "../../i18n";
import styles from "./ProposalDocument.module.css";

/**
 * 永遠掛載，預設 display:none（見 ProposalDocument.module.css）。ExportProposalButton
 * 點擊時會先把它切成可見、用 html2canvas（透過 html2pdf.js）截圖包成 PDF 下載，
 * 擷取完立刻切回隱藏。
 *
 * 用 createPortal 掛到 document.body（而不是留在 RightPanel 的 DOM 樹裡），並用
 * position:absolute（不是 fixed）——實測 html2canvas 在複製文件做截圖時不會正確套用
 * position:fixed，元件仍留在原本巢狀的 flex 版面裡會被旁邊 flex:1 的分頁內容擠成
 * 高度 0，截出來整份空白。掛到 body 上用 absolute 定位可以避開這兩個問題。
 *
 * 內容跟畫面上的 MetricsSnapshot / RerouteSection / SignalCoordinationSection 共用同一批資料，
 * 不重複定義。
 */
export default function ProposalDocument() {
  const alerts = useAppStore((s) => s.alerts);
  const timeOffsetMs = useAppStore((s) => s.timeOffsetMs);
  const incidentGovernmentSummary = useAppStore((s) => s.incidentGovernmentSummary);
  const governmentSummary = useAppStore((s) => s.governmentSummary);
  const incidentCitizenSummary = useAppStore((s) => s.incidentCitizenSummary);
  const citizenSummary = useAppStore((s) => s.citizenSummary);
  const allIncidents = useAppStore((s) => s.allIncidents);
  const { language } = useLanguage();
  const latest = alerts[0];
  const govSummary = incidentGovernmentSummary ?? governmentSummary;
  const citSummary = incidentCitizenSummary ?? citizenSummary;
  const sourceIncident = latest?.sourceIncidentId
    ? allIncidents.find((i) => i.eventId === latest.sourceIncidentId)
    : undefined;
  const [fallbackPlan, setFallbackPlan] = useState<OpsCoordinationPlan | null>(null);

  const needsFallback = !latest?.signalCoordination && !latest?.crossSystemCoordination && !govSummary?.signalCoordination?.length;
  useEffect(() => {
    if (!latest || !needsFallback) {
      setFallbackPlan(null);
      return;
    }
    let cancelled = false;
    opsCoordinationAdapter.getCoordinationPlan(latest).then((result) => {
      if (!cancelled) setFallbackPlan(result);
    });
    return () => { cancelled = true; };
  }, [latest, needsFallback]);

  function resolveSignalTimings(alert: AlertRecord): OpsCoordinationPlan["signalTimings"] {
    if (alert.signalCoordination?.signalTimings?.length) return alert.signalCoordination.signalTimings;
    if (govSummary?.signalCoordination?.length) return govSummary.signalCoordination;
    return fallbackPlan?.signalTimings ?? [];
  }

  function resolveAgencyActions(alert: AlertRecord): OpsCoordinationPlan["interAgencyActions"] {
    const actions = alert.crossSystemCoordination?.interAgencyActions;
    if (actions?.length) return actions as OpsCoordinationPlan["interAgencyActions"];
    if (govSummary?.crossSystemCoordination?.length)
      return govSummary.crossSystemCoordination as OpsCoordinationPlan["interAgencyActions"];
    return fallbackPlan?.interAgencyActions ?? [];
  }

  function resolveActions(alert: AlertRecord): string[] {
    if (alert.actions?.length) return alert.actions;
    if (govSummary?.recommendedActions?.length) return govSummary.recommendedActions;
    return [];
  }

  function resolveSopRef(alert: AlertRecord): string {
    if (alert.sopRef) return alert.sopRef;
    if (govSummary?.sopRefs?.length) return govSummary.sopRefs.join(" / ");
    return "—";
  }

  function resolveNarrativeText(alert: AlertRecord): string {
    if (govSummary?.text) return govSummary.text;
    return alert.llmText ?? alert.ruleSummary;
  }

  if (!latest) return null;

  const kindLabel = pick(language, ALERT_KIND_LABEL[latest.kind].zh, ALERT_KIND_LABEL[latest.kind].en);
  const finalStep = latest.reasoningSteps?.find((s) => s.status === "final");
  const otherSteps = (latest.reasoningSteps ?? []).filter((s) => s.status !== "final");

  // 動態編號：只對實際顯示的項目編號，避免跳號
  let n = 0;
  const N = () => `${++n}.`;

  return createPortal(
    <div id="proposal-document" className={styles.doc}>
      <header className={styles.header}>
        <div>
          <div className={styles.agencyLine}>臺北市政府交通局 交通管制工程處</div>
          <h1 className={styles.docTitle}>交控中心建議書</h1>
          <div className={styles.docSubtitle}>AI Traffic Decision System Official Proposal</div>
        </div>
        <div className={styles.metaBox}>
          <div>
            <strong>事件編號：</strong>
            {latest.sourceIncidentId ?? latest.id}
          </div>
          <div>
            <strong>列印時間：</strong>
            {new Date().toLocaleString("zh-TW")}
          </div>
          <div>
            <strong>機密等級：</strong>內部公務件
          </div>
        </div>
      </header>

      <section className={styles.summaryBanner}>
        <div>
          <span className={styles.summaryLabel}>事件名稱：</span>
          <span className={styles.summaryValue}>{govSummary?.headline ?? latest.title}</span>
        </div>
        <div>
          <span className={styles.summaryLabel}>時間與事件類型：</span>
          <span className={styles.summaryMono}>{formatDisplayTimestamp(latest.timestamp, timeOffsetMs)}</span>
          <span className={styles.summaryTag}>[{kindLabel}]</span>
        </div>
        {sourceIncident && (
          <div>
            <span className={styles.summaryLabel}>事件地點：</span>
            <span>{sourceIncident.location}</span>
          </div>
        )}
        {sourceIncident && (
          <div>
            <span className={styles.summaryLabel}>嚴重程度 / 狀態：</span>
            <span className={styles.summaryMono}>{sourceIncident.severity}</span>
            <span style={{ margin: "0 4px" }}>/</span>
            <span className={styles.summaryMono}>{sourceIncident.status}</span>
          </div>
        )}
        {sourceIncident?.description && (
          <div className={styles.summaryFull}>
            <span className={styles.summaryLabel}>事件描述：</span>
            <span>{sourceIncident.description}</span>
          </div>
        )}
        {latest.ete !== undefined && (
          <div className={styles.summaryFull}>
            <span className={styles.summaryLabel}>預計恢復時間 (ETE)：</span>
            <span className={styles.summaryMono}>
              {latest.ete} 分鐘（基礎 {latest.eteBase ?? 0} 分 + 壅塞加成 {(latest.etePenalty ?? 0).toFixed(1)} 分）
            </span>
          </div>
        )}
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>一、事件辨識與判定依據</h2>
        <p><strong>{N()} 依據 SOP 條款：</strong>{resolveSopRef(latest)}</p>
        {latest.segmentMetrics && (
          <p>
            <strong>{N()} 現場監測數據：</strong>
            車流量 {latest.segmentMetrics.flowPcuh.toLocaleString()} pcu/h，飽和度 (V/C){" "}
            {latest.segmentMetrics.saturation.toFixed(2)}。
          </p>
        )}
        {finalStep && (
          <p><strong>{N()} 預估恢復算式：</strong>{finalStep.detail}</p>
        )}
        <p><strong>{N()} 判定理由說明：</strong>{resolveNarrativeText(latest)}</p>
        {otherSteps.length > 0 && (
          <>
            <p style={{ marginTop: 6 }}><strong>{N()} 推理步驟：</strong></p>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th style={{ width: 24 }}>#</th>
                  <th style={{ width: 52 }}>狀態</th>
                  <th style={{ width: 120 }}>標題</th>
                  <th>說明</th>
                  <th style={{ width: 64 }}>SOP</th>
                </tr>
              </thead>
              <tbody>
                {otherSteps.map((s) => (
                  <tr key={s.order}>
                    <td>{s.order}</td>
                    <td>{s.status}</td>
                    <td>{s.title}</td>
                    <td>{s.detail}</td>
                    <td>{s.sopRef ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>二、建議行動清單</h2>
        {resolveActions(latest).length === 0 ? (
          <p>無建議行動資料。</p>
        ) : (
          <ol className={styles.actionList}>
            {resolveActions(latest).map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ol>
        )}
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>三、替代路徑與疏散導引方案</h2>
        {!latest.reroute ? (
          <p>此事件類型無替代路徑建議（後端未回傳 reroute 資料）。</p>
        ) : (
          <>
            <p>
              <strong>3.1 主要疏散路徑：</strong>
              {latest.reroute.primaryRouteName ?? "（無符合條件之替代路段）"}
            </p>
            {latest.reroute.secondaryRouteNames.length > 0 && (
              <p>
                <strong>3.2 次要替代路徑：</strong>
                {latest.reroute.secondaryRouteNames.join("、")}
              </p>
            )}
            {latest.reroute.excluded.length > 0 && (
              <p>
                <strong>3.3 排除候選路段理由：</strong>
                {latest.reroute.excluded.map((e) => `${e.segmentName}（${e.reason}）`).join("；")}
              </p>
            )}
          </>
        )}
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>四、路段號誌動態調整細節</h2>
        {(() => {
          const timings = resolveSignalTimings(latest);
          if (!timings.length) return <p>方案生成中…</p>;
          return (
            <>
              {fallbackPlan?.period && (
                <p><strong>調整實施時段：</strong>{fallbackPlan.period}</p>
              )}
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>受影響路段</th>
                    <th>綠燈調整幅度</th>
                    <th>目的</th>
                  </tr>
                </thead>
                <tbody>
                  {timings.map((row) => (
                    <tr key={row.intersectionName}>
                      <td>{row.intersectionName}</td>
                      <td>+{row.adjustPct}%</td>
                      <td>{row.goal}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          );
        })()}
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>五、跨單位應變聯動與支援請求</h2>
        {(() => {
          const actions = resolveAgencyActions(latest);
          if (!actions.length) return <p>方案生成中…</p>;
          return actions.map((action) => (
            <p key={action.agency}>
              <strong>• {action.agency}：</strong>
              {action.text}
            </p>
          ));
        })()}
      </section>

      {citSummary && (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>六、民眾版公告摘要</h2>
          {citSummary.headline && (
            <p><strong>標題：</strong>{citSummary.headline}</p>
          )}
          <p className={styles.preWrap}>{citSummary.text}</p>
          {citSummary.recommendedActions.length > 0 && (
            <>
              <p style={{ marginTop: 6 }}><strong>民眾建議行動：</strong></p>
              <ol className={styles.actionList}>
                {citSummary.recommendedActions.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ol>
            </>
          )}
        </section>
      )}

      <footer className={styles.signatureRow}>
        <div className={styles.signatureBlock}>
          <div className={styles.signatureName}>AI 決策系統運算</div>
          <div className={styles.signatureLine}>（系統自動簽核）</div>
        </div>
        <div className={styles.signatureBlock}>
          <div className={styles.signatureName}>值班管制員簽章</div>
          <div className={styles.signatureLine}>（簽章區）</div>
        </div>
        <div className={styles.signatureBlock}>
          <div className={styles.signatureName}>交控中心主任核定</div>
          <div className={styles.signatureLine}>（簽章區）</div>
        </div>
      </footer>

      <div className={styles.docFooter}>
        本建議書由臺北市交通控制中心 AI 智慧決策系統產出，供內部應變指揮參考。
      </div>
    </div>,
    document.body,
  );
}
