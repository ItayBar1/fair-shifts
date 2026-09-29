import { DateTime } from "luxon";
import { UNIT_ZONE } from "./time";

/**
 * Backup policy (decisions 145 and 171): one encrypted daily copy, up to 30 kept
 * subject to the free space, and the newest verified copy is never removed
 * before a replacement is verified.
 */
export const MAX_BACKUPS = 30;
export const MAX_ATTEMPTS = 3;
export const DEFAULT_BACKUP_TIME = "03:30";
/** Waits before the second and third attempts of a transient failure. */
export const RETRY_DELAYS_MS = [15 * 60_000, 60 * 60_000];

export const backupFailures = [
  "not_configured",
  "key_missing",
  "auth_expired",
  "insufficient_space",
  "dump_failed",
  "upload_failed",
  "internal",
] as const;
export type BackupFailureCode = (typeof backupFailures)[number];

/** Retrying cannot fix these; the technical account is alerted at once. */
const permanentFailures: readonly BackupFailureCode[] = [
  "not_configured",
  "key_missing",
  "auth_expired",
  "insufficient_space",
];
export const isTransient = (code: BackupFailureCode) =>
  !permanentFailures.includes(code);

export const failureLabels: Record<BackupFailureCode, string> = {
  not_configured: "יעד הגיבוי אינו מוגדר",
  key_missing: "מפתח ההצפנה הציבורי חסר או שגוי",
  auth_expired: "הרשאת Google Drive פגה או בוטלה",
  insufficient_space: "אין מספיק מקום פנוי ב־Drive",
  dump_failed: "יצירת עותק המסד או ההצפנה נכשלו",
  upload_failed: "העלאת הקובץ או אימות שלמותו נכשלו",
  internal: "תקלה לא צפויה בתהליך הגיבוי",
};

export function validBackupTime(value: string) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return match ? { hour: Number(match[1]), minute: Number(match[2]) } : null;
}

/**
 * The daily run is due from the configured Israel time until the end of that
 * Israel date. A worker that was down at the scheduled time catches up once on
 * return; missed earlier days are not backfilled.
 */
export function dailyBackupDue(now: Date, time = DEFAULT_BACKUP_TIME) {
  const at = validBackupTime(time) ?? validBackupTime(DEFAULT_BACKUP_TIME)!;
  const local = DateTime.fromJSDate(now).setZone(UNIT_ZONE);
  const scheduled = local.set({ ...at, second: 0, millisecond: 0 });
  return local >= scheduled ? `daily:${local.toISODate()}` : null;
}

export function retryDelay(attempts: number) {
  return RETRY_DELAYS_MS[Math.min(attempts, RETRY_DELAYS_MS.length) - 1];
}

export type StoredBackup = {
  id: string;
  finishedAt: Date;
  sizeBytes: number;
};

/**
 * Before an upload: verified copies to remove, oldest first, until the new file
 * fits in the free space. The newest verified copy is never offered, so a
 * shortage it cannot solve fails the run instead (decision 171).
 */
export function spaceToFree<T extends StoredBackup>(
  verified: T[],
  newSize: number,
  freeBytes?: number
) {
  const [, ...older] = newestFirst(verified);
  const remove: T[] = [];
  let free = freeBytes;
  for (const row of older.reverse()) {
    if (fits(free, newSize)) break;
    remove.push(row);
    free = (free ?? 0) + row.sizeBytes;
  }
  return { remove, fits: fits(free, newSize) };
}

/** After a new copy is verified: everything beyond the newest MAX_BACKUPS. */
export function beyondRetention<T extends StoredBackup>(
  verified: T[],
  max = MAX_BACKUPS
) {
  return newestFirst(verified).slice(max);
}

const newestFirst = <T extends StoredBackup>(rows: T[]) =>
  [...rows].sort((a, b) => b.finishedAt.getTime() - a.finishedAt.getTime());
const fits = (free: number | undefined, size: number) =>
  free === undefined || free >= size;
