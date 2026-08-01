import { ChevronDown, Clock3, ExternalLink } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Language } from "../../i18n";
import { pick, useLanguage } from "../../i18n";
import { resolvePublicNoticeUrl } from "../../services/publicNotices";
import { useAppStore } from "../../store/appStore";
import type { AlertRecord, Tier } from "../../types";
import { ALERT_KIND_COLOR, ALERT_KIND_LABEL } from "../../utils/alertLabels";
import { getPublicAlertText } from "../../utils/publicView";
import { formatDisplayShortTime } from "../../utils/timeUtils";
import FieldPositionHint from "../common/FieldPositionHint";
import styles from "./PublicAssistantPanel.module.css";

type Tone = "ok" | "warn" | "crit";

const TIER_RANK: Record<Tier, number> = { A: 0, B: 1, Normal: 2 };

const TILE_RAIL_CLASS: Record<Tone, string> = {
  ok: "tileRailOk",
  warn: "tileRailWarn",
  crit: "tileRailCrit",
};

const TONE_LABEL: Record<Tone, { zh: string; en: string }> = {
  ok: { zh: "正常", en: "Normal" },
  warn: { zh: "留意", en: "Caution" },
  crit: { zh: "避開", en: "Avoid" },
};

const STATUS_WORD: Record<
  Tone,
  { zh: string; en: string; sub: string; subEn: string }
> = {
  ok: {
    zh: "可正常通行",
    en: "Clear to go",
    sub: "建議通行狀態",
    subEn: "Recommended travel status",
  },
  warn: {
    zh: "小心慢行",
    en: "Proceed with care",
    sub: "建議通行狀態",
    subEn: "Recommended travel status",
  },
  crit: {
    zh: "建議避開",
    en: "Avoid the area",
    sub: "建議通行狀態",
    subEn: "Recommended travel status",
  },
};

const ALERT_TONE: Record<AlertRecord["kind"], Tone> = {
  accident: "crit",
  signal_failure: "crit",
  city_response: "warn",
  mrt_diversion: "warn",
  dome_dispersal: "warn",
  multilingual: "ok",
};

function tierMeta(tier: Tier, language: Language): { tone: Tone; tag: string } {
  if (tier === "A")
    return {
      tone: "crit",
      tag: pick(language, "壅塞，建議改道", "Congested — reroute"),
    };
  if (tier === "B")
    return { tone: "warn", tag: pick(language, "略壅塞", "Moderate delays") };
  return { tone: "ok", tag: pick(language, "順暢", "Clear") };
}

function crowdMeta(
  roamingPct: number,
  growthRate: number,
  language: Language,
): { tone: Tone; tag: string } {
  if (roamingPct >= 0.3)
    return { tone: "crit", tag: pick(language, "人潮壅塞", "Very crowded") };
  if (growthRate > 0.1)
    return {
      tone: "warn",
      tag: pick(language, "人潮增加中", "Crowd building"),
    };
  return { tone: "ok", tag: pick(language, "人潮平穩", "Normal flow") };
}

function scrollToAnchor(
  event: React.MouseEvent<HTMLAnchorElement>,
  id: string,
) {
  const target = document.getElementById(id);
  if (!target) return;
  event.preventDefault();
  target.scrollIntoView({ behavior: "smooth", block: "start" });
}

export default function PublicAssistantPanel() {
  const { language } = useLanguage();
  const segments = useAppStore((s) => s.segments);
  const stations = useAppStore((s) => s.stations);
  const alerts = useAppStore((s) => s.alerts);
  const currentTime = useAppStore((s) => s.currentTime);
  const timeOffsetMs = useAppStore((s) => s.timeOffsetMs);

  const topRoads = useMemo(
    () =>
      Object.values(segments)
        .sort(
          (a, b) =>
            TIER_RANK[a.tier] - TIER_RANK[b.tier] ||
            b.saturation - a.saturation,
        )
        .slice(0, 3),
    [segments],
  );

  const topStations = useMemo(
    () =>
      Object.values(stations)
        .sort((a, b) => b.roamingPct - a.roamingPct || b.growthRate - a.growthRate)
        .slice(0, 3),
    [stations],
  );

  const mostAffectedRoad =
    topRoads.find((seg) => seg.tier !== "Normal") ?? null;
  const latestAlert = alerts[0];

  const heroTone: Tone = latestAlert
    ? ALERT_TONE[latestAlert.kind]
    : mostAffectedRoad
      ? tierMeta(mostAffectedRoad.tier, language).tone
      : "ok";

  const heroKindLabel = latestAlert
    ? pick(
        language,
        ALERT_KIND_LABEL[latestAlert.kind].zh,
        ALERT_KIND_LABEL[latestAlert.kind].en,
      )
    : pick(language, "城市狀態", "City status");

  const heroReason = latestAlert
    ? getPublicAlertText(latestAlert, language)
    : mostAffectedRoad
      ? pick(
          language,
          `${mostAffectedRoad.name} 周邊可能延誤，建議改道或延後出發。`,
          `${mostAffectedRoad.name} may be delayed. Consider rerouting or leaving later.`,
        )
      : pick(
          language,
          "目前主要道路與人流狀態穩定，可依原計畫移動。",
          "Roads and crowds are stable. You can continue as planned.",
        );

  const statusWord = STATUS_WORD[heroTone];
  const toneLabel = TONE_LABEL[heroTone];
  const updatedAt = formatDisplayShortTime(currentTime, timeOffsetMs);

  const advisories = alerts.slice(0, 3);

  // 現場公告卡片的「查看官方公告」連結：incident 來源的 alert 會帶 publicManifestUrl
  // （backend 相對路徑），但那只是當天 manifest.json，還要 fetch 並比對 alertId
  // 才能拿到真正的公告內容網址（見 services/publicNotices.ts）。
  const [noticeUrls, setNoticeUrls] = useState<Record<string, string | null>>({});
  const pendingNoticeFetches = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const alert of advisories) {
      if (!alert.publicManifestUrl) continue;
      if (alert.id in noticeUrls || pendingNoticeFetches.current.has(alert.id)) continue;
      pendingNoticeFetches.current.add(alert.id);
      resolvePublicNoticeUrl(alert.publicManifestUrl, alert.id)
        .then((url) => setNoticeUrls((prev) => ({ ...prev, [alert.id]: url })))
        .catch(() => setNoticeUrls((prev) => ({ ...prev, [alert.id]: null })))
        .finally(() => pendingNoticeFetches.current.delete(alert.id));
    }
  }, [advisories, noticeUrls]);

  return (
    <div className={styles.wrap}>
      <div className={styles.heroCard}>
        <span className={styles.title}>
          {pick(language, "目前狀態", "Current Status")}
        </span>
        <FieldPositionHint />
        <div className={styles.heroHead}>
          <span className={styles.heroKind}>{heroKindLabel}</span>
        </div>
        <div className={styles.metaRow}>
          <span className={styles.updatedAt}>
            <Clock3 size={13} aria-hidden="true" />
            {pick(language, `更新於 ${updatedAt}`, `Updated ${updatedAt}`)}
          </span>
          <span className={styles.tonePill} data-tone={heroTone}>
            {pick(language, toneLabel.zh, toneLabel.en)}
          </span>
        </div>
        <div className={styles.primaryStatus}>
          <strong>{pick(language, statusWord.zh, statusWord.en)}</strong>
          <span>{pick(language, statusWord.sub, statusWord.subEn)}</span>
        </div>
        {latestAlert?.ete !== undefined && (
          <div className={styles.recoveryRow}>
            <Clock3 size={14} aria-hidden="true" />
            <span>
              {pick(
                language,
                `預估 ${latestAlert.ete} 分鐘後恢復通行`,
                `Est. ${latestAlert.ete} min until traffic recovers`,
              )}
            </span>
          </div>
        )}
        <p className={styles.heroReason}>{heroReason}</p>
        <div className={styles.navLinks}>
          <a
            href="#public-roads"
            className={styles.navLink}
            onClick={(e) => scrollToAnchor(e, "public-roads")}
          >
            <span>{pick(language, "路況", "Roads")}</span>
            <ChevronDown size={12} aria-hidden="true" />
          </a>
          <a
            href="#public-crowd"
            className={styles.navLink}
            onClick={(e) => scrollToAnchor(e, "public-crowd")}
          >
            <span>{pick(language, "人潮", "Crowds")}</span>
            <ChevronDown size={12} aria-hidden="true" />
          </a>
          <a
            href="#public-advisory"
            className={styles.navLink}
            onClick={(e) => scrollToAnchor(e, "public-advisory")}
          >
            <span>{pick(language, "公告", "Advisories")}</span>
            <ChevronDown size={12} aria-hidden="true" />
          </a>
        </div>
      </div>

      <section id="public-advisory" className={styles.section}>
        <div className={styles.sectionTitleRow}>
          <span className={styles.sectionTitle}>
            {pick(language, "現場公告", "Live Advisories")}
          </span>
        </div>
        {advisories.length > 0 ? (
          <div className={styles.advisoryList}>
            {advisories.map((alert) => (
              <div key={alert.id} className={styles.advisoryCard}>
                <div className={styles.advisoryMeta}>
                  <span
                    className={styles.advisoryKind}
                    style={{ color: ALERT_KIND_COLOR[alert.kind] }}
                  >
                    {pick(
                      language,
                      ALERT_KIND_LABEL[alert.kind].zh,
                      ALERT_KIND_LABEL[alert.kind].en,
                    )}
                  </span>
                  <span className={styles.advisoryTime}>
                    <Clock3 size={11} aria-hidden="true" />
                    {formatDisplayShortTime(alert.timestamp, timeOffsetMs)}
                  </span>
                </div>
                <p className={styles.advisoryText}>
                  {getPublicAlertText(alert, language)}
                </p>
                {alert.ete !== undefined && (
                  <span className={styles.advisoryEte}>
                    <Clock3 size={11} aria-hidden="true" />
                    {pick(
                      language,
                      `預估 ${alert.ete} 分鐘後恢復通行`,
                      `Est. ${alert.ete} min until recovery`,
                    )}
                  </span>
                )}
                {noticeUrls[alert.id] && (
                  <a
                    className={styles.advisoryLink}
                    href={noticeUrls[alert.id]!}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <ExternalLink size={11} aria-hidden="true" />
                    {pick(language, "查看官方公告", "View official notice")}
                  </a>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className={styles.empty}>
            {pick(
              language,
              "城市監控中，目前沒有需要留意的公開事件。",
              "Monitoring the city — no public incidents right now.",
            )}
          </p>
        )}
      </section>

      <section id="public-roads" className={styles.section}>
        <div className={styles.sectionTitleRow}>
          <span className={styles.sectionTitle}>
            {pick(language, "即時路況", "Road Conditions")}
          </span>
        </div>
        <div className={styles.tileList}>
          {topRoads.map((seg) => {
            const meta = tierMeta(seg.tier, language);
            return (
              <div key={seg.segmentId} className={styles.tile}>
                <span
                  className={`${styles.tileRail} ${styles[TILE_RAIL_CLASS[meta.tone]]}`}
                />
                <div className={styles.tileMain}>
                  <span className={styles.tileName}>{seg.name}</span>
                  <span className={styles.tileTag}>{meta.tag}</span>
                </div>
                <span className={styles.tileValue}>{seg.avgSpeed} km/h</span>
              </div>
            );
          })}
        </div>
      </section>

      <section id="public-crowd" className={styles.section}>
        <div className={styles.sectionTitleRow}>
          <span className={styles.sectionTitle}>
            {pick(language, "人潮熱點", "Crowd Hotspots")}
          </span>
        </div>
        <div className={styles.tileList}>
          {topStations.map((st) => {
            const meta = crowdMeta(st.roamingPct, st.growthRate, language);
            const count =
              st.userCount >= 1000
                ? `${(st.userCount / 1000).toFixed(1)}k`
                : `${st.userCount}`;
            return (
              <div key={st.stationId} className={styles.tile}>
                <span
                  className={`${styles.tileRail} ${styles[TILE_RAIL_CLASS[meta.tone]]}`}
                />
                <div className={styles.tileMain}>
                  <span className={styles.tileName}>{st.name}</span>
                  <span className={styles.tileTag}>{meta.tag}</span>
                </div>
                <span className={styles.tileValue}>
                  {pick(language, `${count} 人`, `${count}`)}
                </span>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
