import { AlertTriangle, Clock3, MapPin, MessageCircle, Phone, Route, Users } from "lucide-react";
import { useMemo } from "react";
import { useAppStore } from "../../store/appStore";
import { pick, useLanguage } from "../../i18n";
import type { Language } from "../../i18n";
import type { AlertRecord, Tier } from "../../types";
import { ALERT_KIND_COLOR, ALERT_KIND_LABEL } from "../../utils/alertLabels";
import { getPublicAlertText } from "../../utils/publicView";
import { formatDisplayShortTime } from "../../utils/timeUtils";
import CollapsibleSection from "../common/CollapsibleSection";
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

const STATUS_WORD: Record<Tone, { zh: string; en: string; sub: string; subEn: string }> = {
  ok: { zh: "可正常通行", en: "Clear to go", sub: "建議通行狀態", subEn: "Recommended travel status" },
  warn: { zh: "小心慢行", en: "Proceed with care", sub: "建議通行狀態", subEn: "Recommended travel status" },
  crit: { zh: "建議避開", en: "Avoid the area", sub: "建議通行狀態", subEn: "Recommended travel status" },
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
  if (tier === "A") return { tone: "crit", tag: pick(language, "壅塞，建議改道", "Congested — reroute") };
  if (tier === "B") return { tone: "warn", tag: pick(language, "略壅塞", "Moderate delays") };
  return { tone: "ok", tag: pick(language, "順暢", "Clear") };
}

function crowdMeta(roamingPct: number, growthRate: number, language: Language): { tone: Tone; tag: string } {
  if (roamingPct >= 0.3) return { tone: "crit", tag: pick(language, "人潮壅塞", "Very crowded") };
  if (growthRate > 0.1) return { tone: "warn", tag: pick(language, "人潮增加中", "Crowd building") };
  return { tone: "ok", tag: pick(language, "人潮平穩", "Normal flow") };
}

function scrollToAnchor(event: React.MouseEvent<HTMLAnchorElement>, id: string) {
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
        .sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.saturation - a.saturation)
        .slice(0, 3),
    [segments],
  );

  const topStations = useMemo(
    () => Object.values(stations).sort((a, b) => b.userCount - a.userCount).slice(0, 3),
    [stations],
  );

  const mostAffectedRoad = topRoads.find((seg) => seg.tier !== "Normal") ?? null;
  const latestAlert = alerts[0];

  const heroTone: Tone = latestAlert
    ? ALERT_TONE[latestAlert.kind]
    : mostAffectedRoad
      ? tierMeta(mostAffectedRoad.tier, language).tone
      : "ok";

  const heroKindLabel = latestAlert
    ? pick(language, ALERT_KIND_LABEL[latestAlert.kind].zh, ALERT_KIND_LABEL[latestAlert.kind].en)
    : pick(language, "城市狀態", "City status");

  const heroReason = latestAlert
    ? getPublicAlertText(latestAlert, language)
    : mostAffectedRoad
      ? pick(
          language,
          `${mostAffectedRoad.name} 周邊可能延誤，建議改道或延後出發。`,
          `${mostAffectedRoad.name} may be delayed. Consider rerouting or leaving later.`,
        )
      : pick(language, "目前主要道路與人流狀態穩定，可依原計畫移動。", "Roads and crowds are stable. You can continue as planned.");

  const statusWord = STATUS_WORD[heroTone];
  const toneLabel = TONE_LABEL[heroTone];
  const updatedAt = formatDisplayShortTime(currentTime, timeOffsetMs);

  const advisories = alerts.slice(0, 3);

  return (
    <div className={styles.wrap}>
      <span className={styles.title}>{pick(language, "目前狀態", "Current Status")}</span>

      <div className={styles.heroCard}>
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
        <p className={styles.heroReason}>{heroReason}</p>
        <div className={styles.navLinks}>
          <a href="#public-roads" className={styles.navLink} onClick={(e) => scrollToAnchor(e, "public-roads")}>
            <Route size={12} aria-hidden="true" />
            <span>{pick(language, "路況", "Roads")}</span>
          </a>
          <a href="#public-crowd" className={styles.navLink} onClick={(e) => scrollToAnchor(e, "public-crowd")}>
            <Users size={12} aria-hidden="true" />
            <span>{pick(language, "人潮", "Crowds")}</span>
          </a>
          <a href="#public-advisory" className={styles.navLink} onClick={(e) => scrollToAnchor(e, "public-advisory")}>
            <AlertTriangle size={12} aria-hidden="true" />
            <span>{pick(language, "公告", "Advisories")}</span>
          </a>
          <a href="#public-faq" className={styles.navLink} onClick={(e) => scrollToAnchor(e, "public-faq")}>
            <MessageCircle size={12} aria-hidden="true" />
            <span>{pick(language, "常見問題", "FAQ")}</span>
          </a>
        </div>
      </div>

      <section id="public-roads" className={styles.section}>
        <div className={styles.sectionTitleRow}>
          <Route size={14} aria-hidden="true" />
          <span className={styles.sectionTitle}>{pick(language, "即時路況", "Road Conditions")}</span>
        </div>
        <div className={styles.tileList}>
          {topRoads.map((seg) => {
            const meta = tierMeta(seg.tier, language);
            return (
              <div key={seg.segmentId} className={styles.tile}>
                <span className={`${styles.tileRail} ${styles[TILE_RAIL_CLASS[meta.tone]]}`} />
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
          <Users size={14} aria-hidden="true" />
          <span className={styles.sectionTitle}>{pick(language, "人潮熱點", "Crowd Hotspots")}</span>
        </div>
        <div className={styles.tileList}>
          {topStations.map((st) => {
            const meta = crowdMeta(st.roamingPct, st.growthRate, language);
            const count = st.userCount >= 1000 ? `${(st.userCount / 1000).toFixed(1)}k` : `${st.userCount}`;
            return (
              <div key={st.stationId} className={styles.tile}>
                <span className={`${styles.tileRail} ${styles[TILE_RAIL_CLASS[meta.tone]]}`} />
                <div className={styles.tileMain}>
                  <span className={styles.tileName}>{st.name}</span>
                  <span className={styles.tileTag}>{meta.tag}</span>
                </div>
                <span className={styles.tileValue}>{pick(language, `${count} 人`, `${count}`)}</span>
              </div>
            );
          })}
        </div>
      </section>

      <section id="public-advisory" className={styles.section}>
        <div className={styles.sectionTitleRow}>
          <AlertTriangle size={14} aria-hidden="true" />
          <span className={styles.sectionTitle}>{pick(language, "現場公告", "Live Advisories")}</span>
        </div>
        {advisories.length > 0 ? (
          <div className={styles.advisoryList}>
            {advisories.map((alert) => (
              <div key={alert.id} className={styles.advisoryCard}>
                <div className={styles.advisoryMeta}>
                  <span className={styles.advisoryKind} style={{ color: ALERT_KIND_COLOR[alert.kind] }}>
                    {pick(language, ALERT_KIND_LABEL[alert.kind].zh, ALERT_KIND_LABEL[alert.kind].en)}
                  </span>
                  <span className={styles.advisoryTime}>
                    <Clock3 size={11} aria-hidden="true" />
                    {formatDisplayShortTime(alert.timestamp, timeOffsetMs)}
                  </span>
                </div>
                <p className={styles.advisoryText}>{getPublicAlertText(alert, language)}</p>
              </div>
            ))}
          </div>
        ) : (
          <p className={styles.empty}>
            {pick(language, "城市監控中，目前沒有需要留意的公開事件。", "Monitoring the city — no public incidents right now.")}
          </p>
        )}
      </section>

      <section id="public-faq" className={styles.section}>
        <CollapsibleSection
          storageKey="public-prompts"
          className={styles.collapsible}
          title={pick(language, "常見問題", "Frequently Asked Questions")}
        >
          <div className={styles.prompts}>
            <span>
              <MapPin size={13} aria-hidden="true" />
              {pick(language, "我要去小巨蛋，現在適合嗎？", "Is it okay to go to Taipei Arena now?")}
            </span>
            <span>
              <Route size={13} aria-hidden="true" />
              {pick(language, "哪幾個區域建議避開？", "Which areas should I avoid?")}
            </span>
            <span>
              <Users size={13} aria-hidden="true" />
              {pick(language, "哪個捷運站現在人比較少？", "Which MRT station is less crowded right now?")}
            </span>
            <span>
              <AlertTriangle size={13} aria-hidden="true" />
              {pick(language, "目前有沒有需要注意的事件？", "Are there any incidents I should know about?")}
            </span>
            <span>
              <MessageCircle size={13} aria-hidden="true" />
              {pick(language, "請幫我產生英文旅客提醒。", "Create an English visitor notice.")}
            </span>
          </div>
        </CollapsibleSection>
      </section>

      <section className={styles.footer}>
        <Phone size={14} aria-hidden="true" />
        <p>{pick(language, "緊急狀況請立即撥打 110（警察）或 119（消防／救護）。", "For emergencies, call 110 (Police) or 119 (Fire/Ambulance) immediately.")}</p>
      </section>
    </div>
  );
}
