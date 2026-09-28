import { obj, str, type Row } from "./types";

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
