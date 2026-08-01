import { useEffect } from "react";
import { useAppStore } from "./store/appStore";
import Header from "./components/Header/Header";
import MapStage from "./components/MapStage/MapStage";
import BottomBar from "./components/BottomBar/BottomBar";
import RightPanel from "./components/RightPanel/RightPanel";
import ChatFab from "./components/ChatFab/ChatFab";
import styles from "./App.module.css";

function App() {
  const init = useAppStore((s) => s.init);
  const isPlaying = useAppStore((s) => s.isPlaying);
  const ticks = useAppStore((s) => s.ticks);
  const tickIndex = useAppStore((s) => s.tickIndex);
  const legDurationMs = useAppStore((s) => s.legDurationMs);
  const advanceTime = useAppStore((s) => s.advanceTime);
  const viewerMode = useAppStore((s) => s.viewerMode);

  useEffect(() => {
    init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!isPlaying) return;
    if (tickIndex >= ticks.length - 1) return;
    // legDurationMs is the store's single source of truth for the current leg's real
    // duration — a fresh full duration scaled to the sim-time gap being crossed (ticks are
    // unevenly spaced), or whatever's left of it after a pause/resume. Scheduling off it
    // directly (instead of recomputing here) keeps this timer and the playhead's CSS glide
    // in the timeline perfectly in sync.
    const id = window.setTimeout(() => advanceTime(), legDurationMs);
    return () => window.clearTimeout(id);
  }, [isPlaying, legDurationMs, ticks, tickIndex, advanceTime]);

  return (
    <div className={styles.app}>
      <Header />
      <div className={styles.body} data-mode={viewerMode}>
        <div className={styles.mapColumn}>
          <div className={styles.mapCard}>
            <MapStage />
            <BottomBar />
          </div>
        </div>
        <div className={styles.tabColumn}>
          <RightPanel />
        </div>
      </div>
      <ChatFab />
    </div>
  );
}

export default App;
