import { useEffect, useState } from "react";
import { useAppStore } from "./store/appStore";
import { pick, useLanguage } from "./i18n";
import Header from "./components/Header/Header";
import LeftPanel from "./components/LeftPanel/LeftPanel";
import MapStage from "./components/MapStage/MapStage";
import RightPanel from "./components/RightPanel/RightPanel";
import BottomBar from "./components/BottomBar/BottomBar";
import AlertOverlay from "./components/AlertOverlay/AlertOverlay";
import LoadingScreen from "./components/LoadingScreen/LoadingScreen";
import styles from "./App.module.css";

function App() {
  const init = useAppStore((s) => s.init);
  const isLoading = useAppStore((s) => s.isLoading);
  const loadError = useAppStore((s) => s.loadError);
  const isPlaying = useAppStore((s) => s.isPlaying);
  const playbackSpeed = useAppStore((s) => s.playbackSpeed);
  const advanceTime = useAppStore((s) => s.advanceTime);
  const focusZone = useAppStore((s) => s.focusZone);
  const viewerMode = useAppStore((s) => s.viewerMode);
  const { language } = useLanguage();
  const [minimumLoadingDone, setMinimumLoadingDone] = useState(false);

  useEffect(() => {
    init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setMinimumLoadingDone(true), 800);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!isPlaying) return;
    const id = setInterval(() => advanceTime(), playbackSpeed);
    return () => clearInterval(id);
  }, [isPlaying, playbackSpeed, advanceTime]);

  if (isLoading || !minimumLoadingDone) {
    return <LoadingScreen />;
  }

  if (loadError) {
    return <LoadingScreen error={`${pick(language, "資料載入失敗：", "Failed to load data: ")}${loadError}`} />;
  }

  return (
    <div className={styles.app}>
      <Header />
      <div className={styles.body} data-focus={focusZone ?? undefined} data-mode={viewerMode}>
        <div className={styles.left}>
          <LeftPanel />
        </div>
        <div className={styles.center}>
          <div className={styles.mapShell}>
            <MapStage />
            <AlertOverlay />
          </div>
          {viewerMode === "government" && (
            <div className={styles.bottom} data-focus={focusZone === "bottom" ? "active" : undefined}>
              <BottomBar />
            </div>
          )}
        </div>
        <div className={styles.right}>
          <RightPanel />
        </div>
      </div>
    </div>
  );
}

export default App;
