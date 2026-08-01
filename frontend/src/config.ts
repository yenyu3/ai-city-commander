export type DataSource = "demo" | "api";

export const API_BASE_URL: string =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "/api";

export const DATA_SOURCE: DataSource =
  import.meta.env.VITE_DATA_SOURCE === "api" ? "api" : "demo";
