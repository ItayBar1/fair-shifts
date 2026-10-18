"use client";
import { LoadOlder, useOlderHistory } from "../load-older";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CalendarDays,
  UsersRound,
  Clock3,
  Search,
  ChevronRight,
  ChevronLeft,
  MapPin,
  AlertTriangle,
  UserX,
  Scale,
  Filter,
} from "lucide-react";
import { type AppState, type Row, str, num } from "@/client/types";
import {
  type DaySegment,
  dayOfMonth,
  dutyDays,
  isCancelled,
  localDay,
  monthBounds,
  monthGrid,
  monthLabel,
  monthOf,
  segmentLabel,
  shiftMonth,
  shortMonth,
} from "@/client/calendar";
import { Empty, Panel, Status, scrollRegion } from "../ui";
import {
  calendarBoard,
  selectCalendarCard,
  type CalendarControls,
  type CalendarSelection,
} from "@/client/calendar-filters";
import { handlingCount } from "./dashboard";
import {
  activeAssignments,
  dutyRange,
  dutySlots,
  dutyStart,
  dutyStatus,
} from "./duty-helpers";
import { Stat } from "./stat";

export function CalendarView({
  state,
  initialOnlyMine = false,
}: {
  state: AppState;
  initialOnlyMine?: boolean;
}) {
  const router = useRouter();
  // A month grid does not fit a phone; there the list is the calendar.
  const [controls, setControls] = useState<CalendarControls>(() => ({
    mode:
      typeof window !== "undefined" &&
      window.matchMedia("(max-width: 760px)").matches
        ? "list"
        : "month",
    onlyMine: initialOnlyMine,
  }));
  const { onlyMine, mode, selection } = controls;
  const [query, setQuery] = useState("");
  const [month, setMonth] = useState(() =>
    monthOf(str(state.serverNow, new Date().toISOString()))
  );
  const now = new Date().toISOString();
  // A month before the soldier's 90 days reads the earlier slice (decision 235).
  const history = useOlderHistory();
  const monthStart = monthBounds(month).start.toMillis();
  const beforeWindow = !!history && monthStart < Date.parse(history.from);
  const fetchMonth =
    beforeWindow &&
    history.olderAvailable &&
    !history.loading &&
    !history.error;
  useEffect(() => {
    if (fetchMonth) history.loadOlder();
  }, [fetchMonth, history]);
  const select = (card: CalendarSelection) =>
    setControls((current) => selectCalendarCard(current, card));
  const {
    ownIds,
    counts,
    displayed: monthDuties,
  } = calendarBoard({
    duties: state.duties,
    assignments: state.assignments,
    soldierId: state.actor.soldierId,
    month,
    query,
    controls,
    now,
  });
  // A manager takes no part in duties (decision 192). "My duties" and "my score"
  // show only for a manager whose earlier duties are on record, and then show that
  // history; with none, management measures take their place.
  const personal =
    state.actor.role !== "manager" ||
    state.assignments.some(
      (a) =>
        a.soldierId === state.actor.soldierId && str(a.status) !== "cancelled"
    );
  const byDay = new Map<string, { duty: Row; segment: DaySegment }[]>();
  for (const duty of monthDuties)
    for (const { date, segment } of dutyDays(duty))
      byDay.set(date, [...(byDay.get(date) ?? []), { duty, segment }]);
  const today = localDay(now);
  return (
    <>
      <div className="stats-grid" {...scrollRegion("מדדי הלוח")}>
        <Stat
          label="תורנויות החודש"
          value={counts.month}
          detail="מפורסמות בלוח היחידתי"
          icon={CalendarDays}
          onClick={() => select("month")}
          active={selection === "month"}
          accessibleLabel="סינון לפי תורנויות החודש"
        />
        {personal ? (
          <Stat
            label="התורנויות שלי"
            value={counts.mine}
            detail="בחודש המוצג"
            icon={UsersRound}
            tone="blue"
            onClick={() => select("mine")}
            active={selection === "mine"}
            accessibleLabel="סינון לפי התורנויות שלי"
          />
        ) : (
          <Stat
            label="ממתינים לטיפול"
            value={handlingCount(state)}
            detail="במרכז הטיפול"
            icon={AlertTriangle}
            tone="blue"
            onClick={() => router.push("/manage")}
            accessibleLabel="הצגת ממתינים לטיפול"
          />
        )}
        <Stat
          label="בהמשך הדרך"
          value={counts.upcoming}
          detail="טרם הסתיימו בחודש המוצג"
          icon={Clock3}
          tone="amber"
          onClick={() => select("upcoming")}
          active={selection === "upcoming"}
          accessibleLabel="סינון לפי בהמשך הדרך"
        />
        {personal ? (
          <Stat
            label="הניקוד שלי"
            value={num(
              state.soldiers.find((s) => s.id === state.actor.soldierId)
                ?.currentScore ??
                state.soldiers.find((s) => s.id === state.actor.soldierId)
                  ?.score
            )}
            detail="נקודות שכבר נזקפו"
            icon={Scale}
            tone="violet"
            onClick={() => router.push("/fairness#my-score")}
            accessibleLabel="הצגת הניקוד שלי בטבלת הצדק"
          />
        ) : (
          <Stat
            label="מקומות פנויים בחודש"
            value={counts.vacant}
            detail="בתורנויות שפורסמו"
            icon={UserX}
            tone="violet"
            onClick={() => select("vacant")}
            active={selection === "vacant"}
            accessibleLabel="סינון לפי מקומות פנויים בחודש"
          />
        )}
      </div>
      <Panel className="calendar-panel">
        <div className="calendar-toolbar">
          <div className="month-switch">
            <button
              className="icon-btn"
              aria-label="החודש הקודם"
              onClick={() => setMonth(shiftMonth(month, -1))}
            >
              <ChevronRight size={19} />
            </button>
            <h2 aria-live="polite">{monthLabel(month)}</h2>
            <button
              className="icon-btn"
              aria-label="החודש הבא"
              onClick={() => setMonth(shiftMonth(month, 1))}
            >
              <ChevronLeft size={19} />
            </button>
            <button
              className="btn small secondary"
              onClick={() => setMonth(monthOf(new Date().toISOString()))}
            >
              היום
            </button>
          </div>
          {beforeWindow && <LoadOlder what="תורנויות" />}
          <div className="toolbar-controls">
            <label className="search">
              <Search size={17} />
              <input
                aria-label="חיפוש תורנות"
                placeholder="חיפוש תורנות…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            {personal && (
              <div className="segmented">
                <button
                  aria-pressed={!onlyMine}
                  className={!onlyMine ? "selected" : ""}
                  onClick={() => setControls({ mode, onlyMine: false })}
                >
                  כל היחידה
                </button>
                <button
                  aria-pressed={onlyMine}
                  className={onlyMine ? "selected" : ""}
                  onClick={() => setControls({ mode, onlyMine: true })}
                >
                  התורנויות שלי
                </button>
              </div>
            )}
            <div className="segmented">
              <button
                className={mode === "month" ? "selected" : ""}
                onClick={() => setControls({ mode: "month", onlyMine })}
                aria-pressed={mode === "month"}
                aria-label="תצוגת חודש"
              >
                <CalendarDays size={17} />
              </button>
              <button
                className={mode === "list" ? "selected" : ""}
                onClick={() => setControls({ mode: "list", onlyMine })}
                aria-pressed={mode === "list"}
                aria-label="תצוגת רשימה"
              >
                <Filter size={17} />
              </button>
            </div>
          </div>
        </div>
        {selection && (
          <p className="calendar-selection" role="status">
            {monthDuties.length} תורנויות
            {selection === "vacant"
              ? ` · ${counts.vacant} מקומות פנויים`
              : ""}{" "}
            · לחיצה חוזרת על המשבצת מחזירה לתצוגה הקודמת.
          </p>
        )}
        {mode === "month" ? (
          <div className="calendar-scroll">
            <div className="calendar-grid">
              <div className="calendar-weekdays">
                {["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"].map(
                  (day) => (
                    <span key={day}>{day}</span>
                  )
                )}
              </div>
              <div className="calendar-days">
                {monthGrid(month).map((date, index) => (
                  <div
                    className={`calendar-day ${!date ? "outside" : ""} ${date === today ? "is-today" : ""}`}
                    key={date ?? `pad-${index}`}
                  >
                    {date && (
                      <>
                        <span className="day-number">
                          {Number(date.slice(8))}
                        </span>
                        {(byDay.get(date) ?? []).map(({ duty: d, segment }) => (
                          <Link
                            key={d.id}
                            href={`/duties/${d.id}`}
                            aria-label={`${str(d.name, "תורנות")}, ${segmentLabel(d, segment)}${isCancelled(d) ? ", בוטלה" : ""}`}
                            className={`calendar-event ${segment} ${ownIds.has(d.id) ? "mine" : ""} ${isCancelled(d) ? "cancelled" : ""}`}
                          >
                            <span>{str(d.name, "תורנות")}</span>
                            <small>
                              {segmentLabel(d, segment)}
                              {segment === "single" || segment === "start"
                                ? ` · ${str(d.location, "פרטים בפנים")}`
                                : ""}
                              {isCancelled(d) ? " · בוטלה" : ""}
                            </small>
                          </Link>
                        ))}
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <DutyList state={state} duties={monthDuties} ownIds={ownIds} />
        )}
        <div className="calendar-legend">
          <span>
            <i className="legend-dot teal" />
            תורנות יחידתית
          </span>
          <span>
            <i className="legend-dot blue" />
            תורנות שלי
          </span>
          <span>
            <i className="legend-dot muted" />
            בוטלה
          </span>
          <small>
            הלוח מציג תורנויות שפורסמו, לפי שעון ישראל. תורנות של כמה ימים
            מופיעה בכל יום שבו היא מתקיימת.
          </small>
        </div>
      </Panel>
    </>
  );
}
export function DutyList({
  state,
  duties,
  ownIds,
}: {
  state: AppState;
  duties: Row[];
  /** The viewer's own duties, marked like their color in the month grid. */
  ownIds?: Set<string>;
}) {
  return duties.length ? (
    <div className="duty-list">
      {duties.map((d) => (
        <Link
          href={`/duties/${d.id}`}
          className={`duty-row ${ownIds?.has(str(d.id)) ? "mine" : ""}`}
          key={d.id}
        >
          <span className="date-tile">
            <strong>{dayOfMonth(dutyStart(d))}</strong>
            <small>{shortMonth(dutyStart(d))}</small>
          </span>
          <span className="duty-row-title">
            <strong>{str(d.name, "תורנות")}</strong>
            <small className="duty-row-when">
              <Clock3 size={13} aria-hidden="true" />
              {dutyRange(d)}
            </small>
            <small>
              <MapPin size={13} aria-hidden="true" />
              {str(d.location, "המיקום טרם נקבע")}
            </small>
          </span>
          <span className="duty-row-seats">
            <UsersRound size={15} aria-hidden="true" />{" "}
            {activeAssignments(state, d.id).length}
            {dutySlots(d).length ? ` / ${dutySlots(d).length}` : ""}
          </span>
          {/* A phone shows the status only when it is not the usual "published". */}
          <span
            className={`duty-row-status ${dutyStatus(d) === "published" ? "hide-mobile" : ""}`}
          >
            <Status value={dutyStatus(d)} />
          </span>
          <ChevronLeft size={18} aria-hidden="true" />
        </Link>
      ))}
    </div>
  ) : (
    <Empty
      title="אין תורנויות להצגה"
      text="תורנויות שיפורסמו יופיעו כאן עם כל פרטי הביצוע."
    />
  );
}
