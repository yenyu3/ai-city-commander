import { useAppStore } from "../../store/appStore";
import { pick, useLanguage } from "../../i18n";
import styles from "./TimeFilter.module.css";

const SPEEDS = [
  { label: "1x", ms: 1500 },
  { label: "2x", ms: 750 },
  { label: "4x", ms: 375 },
];

export default function TimeFilter() {
  const ticks = useAppStore((s) => s.ticks);
  const tickIndex = useAppStore((s) => s.tickIndex);
  const isPlaying = useAppStore((s) => s.isPlaying);
  const playbackSpeed = useAppStore((s) => s.playbackSpeed);
  const play = useAppStore((s) => s.play);
  const pause = useAppStore((s) => s.pause);
  const seekTime = useAppStore((s) => s.seekTime);
  const setPlaybackSpeed = useAppStore((s) => s.setPlaybackSpeed);
  const { language } = useLanguage();

  if (ticks.length === 0) return null;

  return (
    <div className={styles.bar}>
      <button
        className={styles.playBtn}
        onClick={() => (isPlaying ? pause() : play())}
      >
        {isPlaying ? pick(language, "❚❚ 暫停", "❚❚ Pause") : pick(language, "▶ 播放", "▶ Play")}
      </button>
      <input
        type="range"
        min={0}
        max={ticks.length - 1}
        value={tickIndex}
        onChange={(e) => seekTime(ticks[Number(e.target.value)])}
        className={styles.slider}
      />
      <span className={styles.time}>{ticks[tickIndex]}</span>
      <div className={styles.speedGroup}>
        {SPEEDS.map((s) => (
          <button
            key={s.label}
            className={`${styles.speedBtn} ${playbackSpeed === s.ms ? styles.speedActive : ""}`}
            onClick={() => setPlaybackSpeed(s.ms)}
          >
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}
