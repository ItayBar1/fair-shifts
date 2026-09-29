import { DateTime } from "luxon";
import { UNIT_ZONE } from "./time";
import type { ServiceProfile } from "./types";

/**
 * Constraint-round notices (decision 163). Each reopening or extension starts a new
 * generation; notices of an older generation are never sent.
 */
export type RoundNotice = "opening" | "reopening" | "extension" | "closing";
export type RoundNoticePhase = "start" | "closing";

export type RoundWindow = {
  status?: unknown;
  opensAt: string;
  closesAt: string;
  reopenedAt?: string | null;
  reopenCount?: unknown;
};

export function roundGeneration(round: Pick<RoundWindow, "reopenCount">) {
  return Number(round.reopenCount ?? 0);
}

/** A generation's window starts when the round opens, or when it was reopened later. */
export function windowStart(round: RoundWindow): number {
  const opens = Date.parse(round.opensAt);
  return round.reopenedAt
    ? Math.max(opens, Date.parse(round.reopenedAt))
    : opens;
}

/**
 * One day before closing, by the Israeli calendar (DST changes keep the local time).
 * A window that opens after that moment gets no closing reminder.
 */
export function closingReminderAt(round: RoundWindow): number | null {
  const due = DateTime.fromISO(round.closesAt, { zone: UNIT_ZONE })
    .minus({ days: 1 })
    .toMillis();
  return due >= windowStart(round) ? due : null;
}

/** Notices are relevant only while submissions are accepted. */
export function acceptsSubmissions(round: RoundWindow, now: number): boolean {
  return (
    round.status !== "closed" &&
    now >= Date.parse(round.opensAt) &&
    now < Date.parse(round.closesAt)
  );
}

/** A soldier receives a round's notices when their service overlaps its target period. */
export function servesDuringRound(
  service: Pick<ServiceProfile, "arrivalDate" | "releaseDate">,
  target: { targetStart: string; targetEnd: string }
): boolean {
  return (
    (!service.arrivalDate || service.arrivalDate <= target.targetEnd) &&
    (!service.releaseDate || service.releaseDate >= target.targetStart)
  );
}

export function roundEventKey(
  roundId: string,
  generation: number,
  notice: RoundNotice,
  accountId: string
) {
  return `round:${roundId}:${generation}:${notice}:${accountId}`;
}

export function parseRoundEventKey(key: string) {
  const match =
    /^round:([0-9a-f-]{36}):(\d+):(opening|reopening|extension|closing):(.+)$/.exec(
      key
    );
  return match
    ? {
        roundId: match[1],
        generation: Number(match[2]),
        notice: match[3] as RoundNotice,
        accountId: match[4],
      }
    : null;
}

function israelTime(value: string) {
  return DateTime.fromISO(value, { zone: UNIT_ZONE }).toFormat(
    "dd.MM.yyyy HH:mm"
  );
}

/** No reasons, exemptions or other people's details: only the round and its window. */
export function roundNoticeText(
  notice: RoundNotice,
  round: { name?: unknown; closesAt: string }
) {
  const name = `״${String(round.name ?? "")}״`;
  const until = israelTime(round.closesAt);
  const missing = "טרם הגשת אילוצים או ״אין לי אילוצים״ בסבב זה.";
  switch (notice) {
    case "opening":
      return {
        title: "סבב אילוצים נפתח",
        body: `אפשר להגיש אילוצים לסבב ${name} עד ${until}.`,
      };
    case "reopening":
      return {
        title: "סבב האילוצים נפתח מחדש",
        body: `אפשר להגיש אילוצים לסבב ${name} עד ${until}. ${missing}`,
      };
    case "extension":
      return {
        title: "מועד ההגשה בסבב האילוצים עודכן",
        body: `אפשר להגיש אילוצים לסבב ${name} עד ${until}. ${missing}`,
      };
    case "closing":
      return {
        title: "תזכורת: סבב האילוצים נסגר בקרוב",
        body: `ההגשה לסבב ${name} נסגרת ב־${until}. ${missing}`,
      };
  }
}
