export function parseTimestamp(ts: string): number {
  return new Date(ts.replace(" ", "T")).getTime();
}

/**
 * 把 demo 資料集的 raw timestamp（"YYYY-MM-DD HH:MM"，代表台北時間）轉成後端 API
 * 需要的 `scenarioAt` 格式（ISO 8601 + 時區，見 docs/backend-docs.md），例如
 * "2026-05-20 21:00" -> "2026-05-20T21:00:00+08:00"。若輸入已經是 ISO 格式（含 "T"）則原樣回傳。
 */
export function toScenarioAt(rawTimestamp: string): string {
  if (rawTimestamp.includes("T")) return rawTimestamp;
  return `${rawTimestamp.replace(" ", "T")}:00+08:00`;
}

export function timePct(ts: string, start: string, end: string): number {
  const s = parseTimestamp(start);
  const e = parseTimestamp(end);
  if (e <= s) return 0;
  const clamped = Math.min(e, Math.max(s, parseTimestamp(ts)));
  return ((clamped - s) / (e - s)) * 100;
}

const TAIPEI_TZ = "Asia/Taipei";

/**
 * The scenario dataset is pinned to a fixed window (2026-05-20 17:00-23:30).
 * To present it as "now" in Taipei time, every displayed timestamp is the raw
 * simulated timestamp shifted by a single offset computed once at load time
 * (see appStore.init) — internal matching/ordering still uses raw timestamps.
 */
export function computeTimeOffsetMs(firstTick: string): number {
  return Date.now() - parseTimestamp(firstTick);
}

export function toDisplayDate(rawTimestamp: string, offsetMs: number): Date {
  return new Date(parseTimestamp(rawTimestamp) + offsetMs);
}

function taipeiParts(date: Date): Record<string, string> {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TAIPEI_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const result: Record<string, string> = {};
  for (const p of parts) result[p.type] = p.value;
  return result;
}

export function formatDisplayTimestamp(rawTimestamp: string, offsetMs: number): string {
  const p = taipeiParts(toDisplayDate(rawTimestamp, offsetMs));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

export function formatDisplayShortTime(rawTimestamp: string, offsetMs: number): string {
  const p = taipeiParts(toDisplayDate(rawTimestamp, offsetMs));
  return `${p.hour}:${p.minute}`;
}

/** Rewrites a leading raw-timestamp prefix (as authored in the scenario data) to the shifted display time. */
export function reformatEmbeddedTimestamp(text: string, rawTimestamp: string, offsetMs: number): string {
  if (!text.startsWith(rawTimestamp)) return text;
  return formatDisplayTimestamp(rawTimestamp, offsetMs) + text.slice(rawTimestamp.length);
}
