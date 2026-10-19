"use client";
import { Fragment } from "react";
import { type AppState, type Row, str } from "@/client/types";
import { localDay, type MonthKey, monthOf } from "@/client/calendar";
import { UNIT_ZONE } from "@/domain/time";
import { Empty } from "../ui";
import { DutyRow } from "./calendar";
import { dutyStart } from "./duty-helpers";

/** "יום שני, 26 באוקטובר" in the unit's zone. */
function dayHeading(date: string) {
  return new Intl.DateTimeFormat("he-IL", {
    timeZone: UNIT_ZONE,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date(`${date}T12:00:00Z`));
}

/**
 * The calendar's list as a roster sheet (decision 241): duties grouped by the
 * day they start, a red "now" rule in the current month, and the days already
 * past folded away (still in the page, so a search or a count finds them).
 */
export function DutyAgenda({
  state,
  duties,
  ownIds,
  month,
  now,
}: {
  state: AppState;
  duties: Row[];
  ownIds: Set<string>;
  month: MonthKey;
  now: string;
}) {
  if (!duties.length)
    return (
      <div className="duty-list">
        <Empty
          title="אין תורנויות להצגה"
          text="תורנויות שיפורסמו יופיעו כאן עם כל פרטי הביצוע."
        />
      </div>
    );
  const days = new Map<string, Row[]>();
  for (const duty of duties) {
    const day = localDay(dutyStart(duty));
    days.set(day, [...(days.get(day) ?? []), duty]);
  }
  const today = localDay(now);
  const current = monthOf(now);
  const thisMonth =
    current.year === month.year && current.month === month.month;
  const entries = [...days];
  const past = thisMonth ? entries.filter(([day]) => day < today) : [];
  const ahead = thisMonth ? entries.filter(([day]) => day >= today) : entries;
  const nowMs = Date.parse(now);
  const group = ([day, list]: [string, Row[]], index: number) => {
    const isToday = thisMonth && day === today;
    // The rule sits before the first duty still to start, today or later.
    const firstAhead = list.findIndex(
      (duty) => Date.parse(dutyStart(duty)) > nowMs
    );
    const ruleAt = isToday
      ? firstAhead === -1
        ? list.length
        : firstAhead
      : -1;
    return (
      <section
        className={`agenda-day ${isToday ? "agenda-day-today" : ""}`}
        key={day}
        aria-label={dayHeading(day)}
      >
        <h3 className="agenda-day-head">
          {isToday && <span className="agenda-today">היום</span>}
          {dayHeading(day)}
          <small>{list.length} תורנויות</small>
        </h3>
        {thisMonth && index === 0 && !isToday && day > today && <NowRule />}
        {list.map((duty, position) => (
          <Fragment key={str(duty.id)}>
            {position === ruleAt && <NowRule />}
            <DutyRow state={state} duty={duty} ownIds={ownIds} />
          </Fragment>
        ))}
        {ruleAt === list.length && <NowRule />}
      </section>
    );
  };
  const pastCount = past.reduce((sum, [, list]) => sum + list.length, 0);
  return (
    <div className="duty-list duty-agenda">
      {past.length > 0 && (
        <details className="agenda-past">
          <summary>
            {pastCount === 1
              ? "תורנות אחת שכבר עברה החודש"
              : `${pastCount} תורנויות שכבר עברו החודש`}
          </summary>
          {past.map((entry, index) => group(entry, index + 1))}
        </details>
      )}
      {ahead.map((entry, index) => group(entry, index))}
      {thisMonth && !ahead.length && <NowRule />}
    </div>
  );
}
function NowRule() {
  return (
    <p className="now-rule" role="separator" aria-label="עכשיו">
      <span>עכשיו</span>
    </p>
  );
}
