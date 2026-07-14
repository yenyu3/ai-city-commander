import { useEffect } from "react";
import { useAppStore } from "./store/appStore";
import { pick, useLanguage } from "./i18n";
import Header from "./components/Header/Header";
import LeftPanel from "./components/LeftPanel/LeftPanel";
import MapStage from "./components/MapStage/MapStage";
import RightPanel from "./components/RightPanel/RightPanel";
import BottomBar from "./components/BottomBar/BottomBar";
import AlertOverlay from "./components/AlertOverlay/AlertOverlay";
import styles from "./App.module.css";

function App() {
  const init = useAppStore((s) => s.init);
  const isLoading = useAppStore((s) => s.isLoading);
  const loadError = useAppStore((s) => s.loadError);
  const isPlaying = useAppStore((s) => s.isPlaying);
  const playbackSpeed = useAppStore((s) => s.playbackSpeed);
  const advanceTime = useAppStore((s) => s.advanceTime);
  const { language } = useLanguage();

  useEffect(() => {
    init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!isPlaying) return;
    const id = setInterval(() => advanceTime(), playbackSpeed);
    return () => clearInterval(id);
  }, [isPlaying, playbackSpeed, advanceTime]);

  if (isLoading) {
    return <div className={styles.loading}>{pick(language, "載入城市即時資料中…", "Loading live city data…")}</div>;
  }
  if (loadError) {
    return (
      <div className={styles.loading}>
        {pick(language, "資料載入失敗：", "Failed to load data: ")}
        {loadError}
      </div>
    );
  }

  return (
    <div className={styles.app}>
      <Header />
      <div className={styles.body}>
        <div className={styles.left}>
          <LeftPanel />
        </div>
        <div className={styles.center}>
          <MapStage />
          <AlertOverlay />
        </div>
        <div className={styles.right}>
          <RightPanel />
        </div>
      </div>
      <BottomBar />
    </div>
  );
}

export default App;
