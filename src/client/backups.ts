import { str } from "./types";

export function formatBytes(value: unknown) {
  if (typeof value !== "number") return "—";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${size.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

/** Daily copy older than a day and a half means the schedule is not keeping up. */
export function backupFreshness(backups: Record<string, unknown>, now: number) {
  if (backups.kind === "none") return "disabled";
  if (!backups.lastVerifiedAt) return "missing";
  return now - new Date(str(backups.lastVerifiedAt)).getTime() > 36 * 3600_000
    ? "stale"
    : "ok";
}
