"use client";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { type AppState, str } from "@/client/types";
import { localDay } from "@/client/calendar";
import { UNIT_ZONE } from "@/domain/time";
import { dutyEnd, dutyRange, dutyStart, dutyStatus } from "./duty-helpers";

/** "היום", "מחר" or "בעוד 6 ימים", counted in the unit's days. */
export function countdown(start: string, now: string) {
  const days = Math.round(
    (Date.parse(localDay(start)) - Date.parse(localDay(now))) / 86_400_000
  );
  return days <= 0 ? "היום" : days === 1 ? "מחר" : `בעוד ${days} ימים`;
}

/**
 * The viewer's next duty in one line above the calendar (decision 241): the
 * answer a soldier opens the app for, before any figure about the unit.
 */
export function NextDutyLine({ state, now }: { state: AppState; now: string }) {
  const own = new Set(
    state.assignments
      .filter(
        (a) =>
          a.soldierId === state.actor.soldierId &&
          ["reserved", "held"].includes(str(a.status))
      )
      .map((a) => str(a.dutyId))
  );
  const next = state.duties
    .filter(
      (d) =>
        own.has(str(d.id)) &&
        dutyStatus(d) === "published" &&
        Date.parse(dutyEnd(d)) > Date.parse(now)
    )
    .sort((a, b) => dutyStart(a).localeCompare(dutyStart(b)))[0];
  if (!next) return null;
  const started = Date.parse(dutyStart(next)) <= Date.parse(now);
  const at = new Date(dutyStart(next));
  const part = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("he-IL", {
      timeZone: UNIT_ZONE,
      ...options,
    }).format(at);
  // A ticket: the date stamped in ink, the duty, then one line about it.
  return (
    <Link
      className="next-duty-line"
      href={`/duties/${next.id}`}
      // Named by what it is first, so the duty's own links keep their names.
      aria-label={`${started ? "התורנות שלי עכשיו" : "התורנות הבאה שלי"}: ${str(next.name, "תורנות")}, ${part({ weekday: "long" })} ${part({ day: "numeric", month: "long" })}, ${dutyRange(next)}${started ? "" : `, ${countdown(dutyStart(next), now)}`}`}
    >
      <span className="next-duty-date" aria-hidden="true">
        <strong>{part({ day: "numeric" })}</strong>
        <span>{part({ month: "short" })}</span>
      </span>
      <span className="next-duty-body">
        <strong>{str(next.name, "תורנות")}</strong>
        <span className="next-duty-meta">
          {started ? "התורנות שלי עכשיו" : "התורנות הבאה שלי"} ·{" "}
          {part({ weekday: "long" })} ·{" "}
          <span className="nowrap">{dutyRange(next)}</span>
          {!started && (
            <>
              {" · "}
              <span className="countdown">
                {countdown(dutyStart(next), now)}
              </span>
            </>
          )}
        </span>
      </span>
      <ChevronLeft size={18} aria-hidden="true" />
    </Link>
  );
}
