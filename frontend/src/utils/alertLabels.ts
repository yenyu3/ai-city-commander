import type { AlertRecord } from "../types";

export const ALERT_KIND_LABEL: Record<AlertRecord["kind"], { zh: string; en: string }> = {
  city_response: { zh: "壅塞分級", en: "Congestion Tier" },
  accident: { zh: "車禍/事件應變", en: "Accident Response" },
  mrt_diversion: { zh: "捷運分流", en: "MRT Diversion" },
  dome_dispersal: { zh: "大巨蛋散場", en: "Dome Egress" },
  signal_failure: { zh: "號誌故障", en: "Signal Failure" },
  multilingual: { zh: "多語通報", en: "Multilingual Alert" },
};

export const ALERT_KIND_COLOR: Record<AlertRecord["kind"], string> = {
  city_response: "var(--warn)",
  accident: "var(--crit)",
  signal_failure: "var(--crit)",
  mrt_diversion: "var(--cyan)",
  dome_dispersal: "var(--cyan)",
  multilingual: "var(--chart-2)",
};
