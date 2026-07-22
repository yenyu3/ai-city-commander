import styles from "./TabBar.module.css";

export interface TabBarItem<K extends string> {
  key: K;
  label: string;
}

export default function TabBar<K extends string>({
  tabs,
  active,
  onChange,
  className,
}: {
  tabs: TabBarItem<K>[];
  active: K;
  onChange: (key: K) => void;
  className?: string;
}) {
  return (
    <div className={`${styles.bar} ${className ?? ""}`} role="tablist">
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          aria-selected={active === t.key}
          className={active === t.key ? styles.tabActive : styles.tab}
          onClick={() => onChange(t.key)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
