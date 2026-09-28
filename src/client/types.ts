export type Row = { id: string; version?: number; [key: string]: unknown };
export type Actor = {
  id: string;
  name: string;
  role: "soldier" | "manager" | "technical";
  soldierId?: string;
  population?: string;
};
export type AppState = {
  actor: Actor;
  soldiers: Row[];
  dutyTypes: Row[];
  duties: Row[];
  assignments: Row[];
  rounds: Row[];
  constraints: Row[];
  requests: Row[];
  ledger: Row[];
  notifications: Row[];
  settings: Record<string, unknown>;
  accounts: Row[];
  audit: Row[];
  imports: Row[];
  operations: Row[];
  [key: string]: unknown;
};
export type Action = (
  type: string,
  payload: Record<string, unknown>,
  expectedVersion?: number
) => Promise<Record<string, unknown>>;
export const str = (value: unknown, fallback = ""): string =>
  typeof value === "string" || typeof value === "number"
    ? String(value)
    : fallback;
export const num = (value: unknown, fallback = 0): number =>
  typeof value === "number"
    ? value
    : typeof value === "string" && Number.isFinite(Number(value))
      ? Number(value)
      : fallback;
export const rows = (value: unknown): Row[] =>
  Array.isArray(value) ? (value as Row[]) : [];
export const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export const populationLabels: Record<string, string> = {
  mandatory: "חובה",
  career: "קבע / קצינים",
  academic: "קמ״א",
  regular: "חובה",
  permanent: "קבע / קצינים",
  kama: "קמ״א",
};
export const population = (value: unknown) =>
  populationLabels[str(value)] || str(value, "לא הוגדרה");
export function displayDate(value: unknown, withTime = false) {
  const text = str(value);
  if (!text) return "—";
  const date = new Date(text);
  if (Number.isNaN(date.valueOf())) return text;
  return new Intl.DateTimeFormat("he-IL", {
    timeZone: "Asia/Jerusalem",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    ...(withTime
      ? { hour: "2-digit" as const, minute: "2-digit" as const }
      : {}),
  }).format(date);
}
export const personName = (state: AppState, id: unknown) =>
  str(state.soldiers.find((s) => s.id === id)?.name, "חייל");
export const dutyName = (state: AppState, id: unknown) =>
  str(state.duties.find((d) => d.id === id)?.name, "תורנות");
