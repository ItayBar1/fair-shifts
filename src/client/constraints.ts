import { displayDate, num, obj, str, type Row } from "./types";
import {
  closingReminderAt,
  windowStart,
  type RoundWindow,
} from "../domain/round-notices";

export type RoundPhase = "upcoming" | "open" | "closed";

/** The submission window as the server enforces it, not only the stored flag. */
export function roundPhase(round: Row, now = Date.now()): RoundPhase {
  if (round.status === "closed") return "closed";
  if (now < new Date(str(round.opensAt)).valueOf()) return "upcoming";
  if (now >= new Date(str(round.closesAt)).valueOf()) return "closed";
  return "open";
}

function hasRange(value: Record<string, unknown>) {
  return typeof value.start === "string" && !value.none;
}

export type ConstraintDisplay = {
  /** Status for the badge: a rejected change over an approved range stays approved. */
  status: string;
  declared: boolean;
  approvedInEffect: boolean;
  changeRejected: boolean;
  /** An approved range or a pending change the soldier may ask to cancel. */
  cancellable: boolean;
};

export function constraintDisplay(row: Row): ConstraintDisplay {
  const approved = obj(row.approved);
  const approvedInEffect = hasRange(approved);
  const declared = row.status === "declared";
  const changeRejected = row.status === "rejected" && approvedInEffect;
  return {
    status: changeRejected ? "approved" : str(row.status, "pending"),
    declared,
    approvedInEffect,
    changeRejected,
    cancellable: approvedInEffect || Boolean(row.pending),
  };
}

const startLabels: Record<string, string> = {
  opening: "הודעת פתיחה",
  reopening: "הודעת פתיחה מחדש",
  extension: "הודעת עדכון מועד",
};

/** Manager view of the current generation's notices (decision 163). */
export function roundNoticeSummary(
  round: Row,
  notices: Row[],
  now = Date.now()
): string[] {
  const generation = Number(round.reopenCount ?? 0);
  const current = notices.filter(
    (row) => row.roundId === round.id && row.generation === generation
  );
  const window: RoundWindow = {
    status: round.status,
    opensAt: str(round.opensAt),
    closesAt: str(round.closesAt),
    reopenedAt: str(round.reopenedAt) || null,
    reopenCount: generation,
  };
  const open = roundPhase(round, now) !== "closed";
  const start = current.find((row) => row.phase === "start");
  const closing = current.find((row) => row.phase === "closing");
  const lines: string[] = [];
  if (start)
    lines.push(
      start.status === "merged"
        ? `${startLabels[str(start.notice)]} צורפה לתזכורת הסגירה`
        : `${startLabels[str(start.notice)]} נשלחה ל־${num(start.recipients)}`
    );
  else if (open)
    lines.push(
      `${startLabels[generation === 0 ? "opening" : round.reopenKind === "extension" ? "extension" : "reopening"]} תישלח ב־${displayDate(new Date(windowStart(window)).toISOString(), true)}`
    );
  const closingAt = closingReminderAt(window);
  if (closing)
    lines.push(`תזכורת סגירה נשלחה ל־${num(closing.recipients)} שטרם הגישו`);
  else if (closingAt === null)
    lines.push("ללא תזכורת סגירה: חלון ההגשה קצר מיום");
  else if (open)
    lines.push(
      `תזכורת סגירה למי שטרם הגיש ב־${displayDate(new Date(closingAt).toISOString(), true)}`
    );
  return lines;
}
