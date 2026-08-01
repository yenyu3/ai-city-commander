import { useState } from "react";
import styles from "./MultilingualPreview.module.css";
import PublishPreviewModal from "./PublishPreviewModal";

export default function MultilingualPreview() {
  // const { language } = useLanguage();
  const [open, setOpen] = useState(false);

  return (
    <div className={styles.wrap}>
      {/* <button className={styles.publishBtn} onClick={() => setOpen(true)}>
        <Send size={14} aria-hidden="true" />
        {pick(language, "預覽並發布多語警示", "Preview & Publish Alerts")}
      </button> */}
      {open && (
        <PublishPreviewModal
          alertId="multilingual-preview"
          onClose={() => setOpen(false)}
          onPublished={() => setOpen(false)}
        />
      )}
    </div>
  );
}
