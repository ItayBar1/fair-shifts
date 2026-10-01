"use client";
import { DutyChanges } from "./duty-changes";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ManualAssignment } from "./manual-assignment";
import {
  PerformanceCorrections,
  performanceOf,
} from "./performance-corrections";
import { LotteryButton, LotteryHistory } from "./planning";
import { ScoreDecisions } from "./score-decisions";
import { ManagerReturns } from "./manager-returns";
import { ExecutionPeriods, referredRequests } from "./execution-periods";
import { deletedSeats } from "@/client/deleted-seats";
import { TransferOffer } from "./transfers";
import { SwapOffer } from "./swaps";
import {
  CancellationRequestButton,
  CancellationRequests,
} from "./cancellation-requests";
import {
  CalendarDays,
  UsersRound,
  Clock3,
  CheckCircle2,
  Search,
  ChevronRight,
  ChevronLeft,
  ArrowLeft,
  MapPin,
  AlertTriangle,
  UserX,
  Scale,
  Filter,
} from "lucide-react";
import {
  type AppState,
  type Action,
  type Row,
  str,
  num,
  rows,
  obj,
  population,
  personName,
  displayDate,
  dutyName,
} from "@/client/types";
import {
  type DaySegment,
  dayOfMonth,
  dutyDays,
  isCancelled,
  localDay,
  monthGrid,
  monthLabel,
  monthOf,
  segmentLabel,
  shiftMonth,
  shortMonth,
} from "@/client/calendar";
import {
  ActionDialog,
  Badge,
  Empty,
  Panel,
  Status,
  QuickAction,
  Notice,
} from "./ui";
import { AuditLink } from "./audit";
import { fairnessTable } from "@/client/fairness";
import {
  calendarBoard,
  selectCalendarCard,
  type CalendarControls,
  type CalendarSelection,
} from "@/client/calendar-filters";
export const dutyStart = (d: Row) => str(d.start ?? d.startsAt);
export const dutyEnd = (d: Row) => str(d.end ?? d.endsAt);
export const dutyStatus = (d: Row) => d.status ?? d.publicationStatus;
export const assignmentSoldier = (a: Row) => str(a.soldierId);
export const activeAssignments = (state: AppState, dutyId: string) =>
  state.assignments.filter(
    (a) =>
      a.dutyId === dutyId &&
      !["cancelled", "transferred"].includes(str(a.status))
  );
export const dutySlots = (d: Row) => rows(d.slots);
export function Stat({
  label,
  value,
  detail,
  icon: Icon,
  tone = "teal",
  onClick,
  active,
  accessibleLabel,
}: {
  label: string;
  value: React.ReactNode;
  detail: string;
  icon: typeof CalendarDays;
  tone?: string;
  onClick?: () => void;
  active?: boolean;
  accessibleLabel?: string;
}) {
  const content = (
    <>
      <span className="stat-top">
        <span>{label}</span>
        <span className={`stat-icon ${tone}`}>
          <Icon size={20} />
        </span>
      </span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </>
  );
  return onClick ? (
    <button
      type="button"
      className={`stat stat-button ${active ? "active" : ""}`}
      aria-label={accessibleLabel ?? label}
      aria-pressed={active}
      onClick={onClick}
    >
      {content}
    </button>
  ) : (
    <div className="stat">{content}</div>
  );
}
export function CalendarView({ state }: { state: AppState }) {
  const router = useRouter();
  const [controls, setControls] = useState<CalendarControls>({
    mode: "month",
    onlyMine: false,
  });
  const { onlyMine, mode, selection } = controls;
  const [query, setQuery] = useState("");
  const [month, setMonth] = useState(() =>
    monthOf(str(state.serverNow, new Date().toISOString()))
  );
  const now = new Date().toISOString();
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
      <div className="stats-grid">
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
          <DutyList state={state} duties={monthDuties} />
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
}: {
  state: AppState;
  duties: Row[];
}) {
  return duties.length ? (
    <div className="duty-list">
      {duties.map((d) => (
        <Link href={`/duties/${d.id}`} className="duty-row" key={d.id}>
          <span className="date-tile">
            <strong>{dayOfMonth(dutyStart(d))}</strong>
            <small>{shortMonth(dutyStart(d))}</small>
          </span>
          <span className="duty-row-title">
            <strong>{str(d.name, "תורנות")}</strong>
            <small>
              <MapPin size={13} />
              {str(d.location, "המיקום טרם נקבע")}
            </small>
            <small className="mobile-only">
              {displayDate(dutyStart(d), true)} –{" "}
              {displayDate(dutyEnd(d), true)}
            </small>
          </span>
          <span className="hide-mobile">
            {displayDate(dutyStart(d), true)}
            <small className="block muted">
              עד {displayDate(dutyEnd(d), true)}
            </small>
          </span>
          <span>
            <UsersRound size={15} /> {activeAssignments(state, d.id).length}
            {dutySlots(d).length ? ` / ${dutySlots(d).length}` : ""}
          </span>
          <Status value={dutyStatus(d)} />
          <ChevronLeft size={18} />
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
export function FairnessView({ state }: { state: AppState }) {
  const ownRow = useRef<HTMLTableRowElement>(null);
  useEffect(() => {
    if (window.location.hash === "#my-score") {
      ownRow.current?.scrollIntoView({ block: "center" });
      ownRow.current?.focus({ preventScroll: true });
    }
  }, []);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("");
  const { ranked, managers } = fairnessTable(state.soldiers);
  const matches = (s: Row) =>
    str(s.name).includes(search) && (!filter || s.population === filter);
  const filtered = ranked.filter(matches);
  const outside = managers.filter(matches);
  return (
    <>
      <Notice>
        הטבלה מציגה נקודות מביצועים שכבר הסתיימו. שיבוצים עתידיים נשמרים בנפרד
        ונכללים בבחירת המועמדים.
        {managers.length > 0 &&
          " אחראי תורנויות אינו משובץ לתורנויות, ולכן אינו מדורג והיתרה שלו מוקפאת."}
      </Notice>
      <Panel
        title="טבלת הצדק היחידתית"
        subtitle={`${ranked.length} חיילים · יתרה זהה מקבלת דירוג משותף${
          managers.length ? ` · ${managers.length} אחראים מחוץ לדירוג` : ""
        }`}
        actions={
          <div className="toolbar-controls">
            <label className="search">
              <Search size={17} />
              <input
                aria-label="חיפוש חייל"
                placeholder="חיפוש לפי שם…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            <select
              aria-label="סינון אוכלוסייה"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            >
              <option value="">כל האוכלוסיות</option>
              <option value="mandatory">חובה</option>
              <option value="career">קבע / קצינים</option>
              <option value="academic">קמ״א</option>
            </select>
          </div>
        }
      >
        {filtered.length || outside.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>דירוג</th>
                  <th>שם החייל</th>
                  <th>אוכלוסייה</th>
                  <th>דרגה</th>
                  <th>נקודות</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((s) => (
                  <tr
                    key={s.id}
                    id={s.id === state.actor.soldierId ? "my-score" : undefined}
                    ref={s.id === state.actor.soldierId ? ownRow : undefined}
                    tabIndex={s.id === state.actor.soldierId ? -1 : undefined}
                    className={
                      s.id === state.actor.soldierId ? "personal-row" : ""
                    }
                  >
                    <td>
                      <span className="rank-number">{s.rank}</span>
                    </td>
                    <td>
                      <span className="person">
                        <span className="avatar small">
                          {str(s.name).slice(0, 1)}
                        </span>
                        <strong>{str(s.name)}</strong>
                        {s.id === state.actor.soldierId && (
                          <Badge tone="info">אני</Badge>
                        )}
                      </span>
                    </td>
                    <td>{population(s.population)}</td>
                    <td>{str(s.rankName ?? s.rank, "—")}</td>
                    <td>
                      <strong className="score-number">
                        {num(s.currentScore ?? s.score)}
                      </strong>
                    </td>
                  </tr>
                ))}
                {outside.map((s) => (
                  <tr
                    key={s.id}
                    id={s.id === state.actor.soldierId ? "my-score" : undefined}
                    ref={s.id === state.actor.soldierId ? ownRow : undefined}
                    tabIndex={s.id === state.actor.soldierId ? -1 : undefined}
                    className={`manager-row ${
                      s.id === state.actor.soldierId ? "personal-row" : ""
                    }`}
                  >
                    <td>
                      <span className="rank-number" aria-label="ללא דירוג">
                        —
                      </span>
                    </td>
                    <td>
                      <span className="person">
                        <span className="avatar small">
                          {str(s.name).slice(0, 1)}
                        </span>
                        <strong>{str(s.name)}</strong>
                        {s.id === state.actor.soldierId && (
                          <Badge tone="info">אני</Badge>
                        )}
                        <Badge>אחראי, לא משתתף</Badge>
                      </span>
                    </td>
                    <td>{population(s.population)}</td>
                    <td>{str(s.rankName ?? s.rank, "—")}</td>
                    <td>
                      <strong className="score-number">
                        {num(s.currentScore ?? s.score)}
                      </strong>{" "}
                      <small className="muted">מוקפאת</small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            title="לא נמצאו חיילים"
            text="אפשר לשנות את הסינון או את החיפוש."
          />
        )}
      </Panel>
    </>
  );
}
/** Everything the handling center lists, so the calendar's count always matches it. */
function handlingSummary(state: AppState) {
  const drafts = state.duties.filter((d) => dutyStatus(d) === "draft");
  const pending = state.constraints.filter((c) => c.status === "pending");
  // A transfer or swap counts only once it waits for a manager; before that it waits for a soldier's consent.
  const requests = state.requests.filter((r) =>
    r.type === "transfer" || r.type === "swap"
      ? r.status === "awaiting_manager"
      : ![
          "completed",
          "rejected",
          "cancelled",
          "declined",
          "expired",
          "referred",
          "closed",
        ].includes(str(r.status))
  );
  const decisions = rows(state.scoreDecisions).filter(
    (row) => row.status === "pending"
  );
  const referred = referredRequests(state);
  // A manager who is a soldier again waits for a decision about the balance (decision 192).
  const returns = rows(state.managerReturns).filter(
    (row) => row.status === "pending"
  );
  // Derived from the dates, so a departure shows even before the worker's notice.
  const departed = state.soldiers.filter(
    (s) => !s.deletedAt && s.serviceStatus === "service_ended"
  );
  // A soldier deleted while a duty ran: urgent, until a manager records the periods (decision 196).
  const urgent = deletedSeats(state);
  const concerns = state.assignments.filter(
    (a) =>
      ["reserved", "held"].includes(str(a.status)) &&
      !urgent.includes(a) &&
      (a.needsReview ||
        (Array.isArray(a.needsAttention) && a.needsAttention.length > 0))
  );
  return {
    drafts,
    pending,
    requests,
    decisions,
    referred,
    returns,
    departed,
    concerns,
    urgent,
  };
}
export function handlingCount(state: AppState) {
  const item = handlingSummary(state);
  return (
    item.pending.length +
    item.requests.length +
    item.decisions.length +
    item.referred.length +
    item.returns.length +
    item.departed.length +
    item.concerns.length +
    item.urgent.length
  );
}
/** Why a reserved assignment needs a manager's attention, from the codes the server stored. */
function concernReason(assignment: Row) {
  const codes = Array.isArray(assignment.needsAttention)
    ? assignment.needsAttention
    : [];
  return codes.includes("manager")
    ? "החייל מונה לאחראי תורנויות ואינו משובץ עוד. השיבוץ בתוקף עד שיוחלף"
    : str(assignment.reviewReason, "הנתונים השתנו לאחר השיבוץ");
}
export function Dashboard({
  state,
  action,
}: {
  state: AppState;
  action: Action;
}) {
  const {
    drafts,
    pending,
    requests,
    decisions,
    referred,
    returns,
    departed,
    concerns,
    urgent,
  } = handlingSummary(state);
  const transfers = requests.filter((r) => r.type === "transfer");
  const swaps = requests.filter((r) => r.type === "swap");
  return (
    <>
      <div className="stats-grid">
        <Stat
          label="חיילים ביחידה"
          value={state.soldiers.filter((s) => !s.deletedAt).length}
          detail="מאגר משותף לכל האחראים"
          icon={UsersRound}
        />
        <Stat
          label="טיוטות לפרסום"
          value={drafts.length}
          detail="עדיין לא נחשפות לחיילים"
          icon={CalendarDays}
          tone="blue"
        />
        <Stat
          label="ממתינים להחלטה"
          value={
            pending.length +
            requests.length +
            decisions.length +
            referred.length +
            returns.length
          }
          detail="אילוצים, החלפות, בקשות ותיקוני יתרה"
          icon={Clock3}
          tone="amber"
        />
        <Stat
          label="שיבוצים לטיפול"
          value={concerns.length + urgent.length}
          detail="נדרשת בדיקת אחראי"
          icon={AlertTriangle}
          tone="violet"
        />
      </div>
      <div className="two-columns">
        <Panel title="על סדר היום" subtitle="החלטות שיקדמו את התכנון">
          {urgent.map((a) => (
            <Link
              className="task-item"
              href={`/duties/${a.dutyId}`}
              key={`deleted-${a.id}`}
            >
              <span className="task-symbol red">
                <AlertTriangle size={20} />
              </span>
              <span>
                <strong>
                  דחוף: {personName(state, a.soldierId)} נמחק באמצע{" "}
                  {dutyName(state, a.dutyId)}
                </strong>
                <small>
                  יש לרשום עד מתי ביצע בפועל, מי מחליף אותו בהמשך ומה הניקוד.
                  הזקיפה האוטומטית של השיבוץ עצורה עד ההכרעה.
                </small>
              </span>
              <ChevronLeft size={18} />
            </Link>
          ))}
          <Link className="task-item" href="/manage/constraints">
            <span className="task-symbol amber">
              <Clock3 size={20} />
            </span>
            <span>
              <strong>סקירת אילוצים</strong>
              <small>{pending.length} הגשות ממתינות להחלטה</small>
            </span>
            <ArrowLeft size={18} />
          </Link>
          <Link className="task-item" href="/requests">
            <span className="task-symbol blue">
              <UsersRound size={20} />
            </span>
            <span>
              <strong>החלפות ובקשות</strong>
              <small>{requests.length} בקשות פתוחות</small>
            </span>
            <ArrowLeft size={18} />
          </Link>
          <Link className="task-item" href="/manage/planning">
            <span className="task-symbol teal">
              <CalendarDays size={20} />
            </span>
            <span>
              <strong>להשלים את הלוח</strong>
              <small>{drafts.length} טיוטות בתכנון</small>
            </span>
            <ArrowLeft size={18} />
          </Link>
          {transfers.map((r) => (
            <Link className="task-item" href="/requests" key={r.id}>
              <span className="task-symbol amber">
                <Clock3 size={20} />
              </span>
              <span>
                <strong>העברה ממתינה להחלטה: {str(r.dutyName)}</strong>
                <small>
                  {personName(state, r.fromSoldierId)} ←{" "}
                  {personName(state, r.acceptedBy)}. עד ההחלטה השיבוץ המקורי
                  בתוקף
                </small>
              </span>
              <ChevronLeft size={18} />
            </Link>
          ))}
          {swaps.map((r) => {
            const accepted = rows(r.candidates).find(
              (item) => item.assignmentId === r.acceptedAssignmentId
            );
            return (
              <Link className="task-item" href="/requests" key={r.id}>
                <span className="task-symbol amber">
                  <Clock3 size={20} />
                </span>
                <span>
                  <strong>
                    החלפה ממתינה להחלטה: {str(r.dutyName)} ⇄{" "}
                    {str(accepted?.dutyName)}
                  </strong>
                  <small>
                    {personName(state, r.fromSoldierId)} ⇄{" "}
                    {personName(state, r.acceptedBy)}. עד ההחלטה השיבוצים
                    המקוריים בתוקף
                  </small>
                </span>
                <ChevronLeft size={18} />
              </Link>
            );
          })}
          {referred.map((r) => (
            <Link
              className="task-item"
              href={`/duties/${str(r.dutyId)}`}
              key={r.id}
            >
              <span className="task-symbol amber">
                <Clock3 size={20} />
              </span>
              <span>
                <strong>טיפול בביצוע: {str(r.dutyName)}</strong>
                <small>
                  בקשת {personName(state, r.soldierId)} הופנתה אחרי תחילת
                  התורנות. יש לרשום את תקופות הביצוע של המקום
                </small>
              </span>
              <ChevronLeft size={18} />
            </Link>
          ))}
          {departed.map((s) => {
            const notice = rows(state.departures).find(
              (row) =>
                row.subjectId === s.id && row.releaseDate === s.releaseDate
            );
            return (
              <Link
                className="task-item"
                href="/manage/soldiers"
                key={`departed-${s.id}`}
              >
                <span className="task-symbol amber">
                  <UserX size={20} />
                </span>
                <span>
                  <strong>{str(s.name)} — השירות הסתיים</strong>
                  <small>
                    יום אחרון {displayDate(s.releaseDate)} · הגישה חסומה
                    {notice
                      ? ` · הודעה נשלחה ${displayDate(notice.detectedAt, true)}`
                      : ""}
                    . הרשומה נשמרת עד החלטת אחראי.
                  </small>
                </span>
                <ChevronLeft size={18} />
              </Link>
            );
          })}
          {concerns.map((a) => (
            <Link className="task-item" href={`/duties/${a.dutyId}`} key={a.id}>
              <span className="task-symbol amber">
                <AlertTriangle size={20} />
              </span>
              <span>
                <strong>
                  {personName(state, a.soldierId)} — שיבוץ דורש טיפול
                </strong>
                <small>{concernReason(a)}</small>
              </span>
              <ChevronLeft size={18} />
            </Link>
          ))}
        </Panel>
        <Panel title="המשך עבודה" subtitle="גישה מהירה לכלים של היחידה">
          <div className="shortcut-grid">
            <Link href="/manage/planning">
              <CalendarDays />
              <strong>תכנון תורנות</strong>
              <small>מופע חדש או מילוי חוסרים</small>
            </Link>
            <Link href="/manage/soldiers">
              <UsersRound />
              <strong>קליטת חייל</strong>
              <small>הוספה והזמנה למערכת</small>
            </Link>
            <Link href="/manage/scores">
              <Scale />
              <strong>ניקוד</strong>
              <small>יתרות ותיקוני היסטוריה</small>
            </Link>
            <Link href="/manage/imports">
              <CheckCircle2 />
              <strong>ייבוא Excel</strong>
              <small>תצוגה מקדימה לפני החלה</small>
            </Link>
          </div>
        </Panel>
      </div>
      {decisions.length > 0 && <ScoreDecisions state={state} action={action} />}
      {returns.length > 0 && <ManagerReturns state={state} action={action} />}
      <Panel
        title="טיוטות משותפות"
        actions={
          <Link href="/manage/planning" className="text-link">
            לתכנון המלא <ArrowLeft size={15} />
          </Link>
        }
      >
        <DutyList state={state} duties={drafts.slice(0, 6)} />
      </Panel>
      {state.accounts.some((a) => a.lockedAt) && (
        <Panel title="חשבונות נעולים">
          {state.accounts
            .filter((a) => a.lockedAt && a.role === "soldier")
            .map((a) => (
              <div className="task-item" key={a.id}>
                <strong>{str(a.name)}</strong>
                <QuickAction
                  action={action}
                  type="account.unlock"
                  payload={{ id: a.id }}
                  version={a.version}
                >
                  שחרור חשבון
                </QuickAction>
              </div>
            ))}
        </Panel>
      )}
    </>
  );
}
export function DutyDetail({
  state,
  action,
  id,
}: {
  state: AppState;
  action: Action;
  id: string;
}) {
  const duty = state.duties.find((d) => d.id === id);
  if (!duty)
    return (
      <Empty
        title="התורנות לא נמצאה"
        text="ייתכן שהוסרה או שאינה זמינה לחשבון שלך."
      />
    );
  const manager = state.actor.role === "manager";
  const assignments = activeAssignments(state, id);
  const slots = dutySlots(duty);
  const future =
    new Date(dutyStart(duty)).getTime() >
    new Date(str(state.serverNow)).getTime();
  return (
    <>
      <Link className="text-link back-link" href="/calendar">
        <ChevronRight size={15} />
        חזרה ללוח התורנויות
      </Link>
      <Panel>
        <div className="duty-hero">
          <span className="large-symbol">
            <CalendarDays size={31} />
          </span>
          <div>
            <div className="inline">
              <Status value={dutyStatus(duty)} />
              {(duty.needsReview === true ||
                assignments.some(
                  (item) =>
                    Array.isArray(item.needsAttention) &&
                    item.needsAttention.length > 0
                )) && <Badge tone="warning">דורשת טיפול</Badge>}
            </div>
            <h2>{str(duty.name)}</h2>
            <div className="meta-line">
              <span>
                <MapPin size={16} />
                {str(duty.location, "לא הוגדר מיקום")}
              </span>
              <span>
                <Clock3 size={16} />
                {displayDate(dutyStart(duty), true)} —{" "}
                {displayDate(dutyEnd(duty), true)}
              </span>
            </div>
          </div>
        </div>
        {duty.instructions ? (
          <div className="instruction-box">
            <h3>מה צריך לדעת</h3>
            <p>{str(duty.instructions)}</p>
          </div>
        ) : null}
        {manager && dutyStatus(duty) === "draft" && !future && (
          <Notice tone="warning">
            מועד תחילת הטיוטה חלף. היא נשארת לטיפול עם השיבוצים והניקוד השמור;
            ניתן לבטל אותה או לטפל בתיעוד הביצוע.
          </Notice>
        )}
        <TransferOffer state={state} action={action} duty={duty} />
        <SwapOffer state={state} action={action} duty={duty} />
        <CancellationRequestButton state={state} action={action} duty={duty} />
        {manager && (
          <div className="panel-actions">
            <AuditLink id={id} label="יומן הפעולות של התורנות" />
            {dutyStatus(duty) === "draft" && future && (
              <ActionDialog
                title="פרסום התורנות"
                buttonLabel="פרסום לחיילים"
                description="לאחר הפרסום התורנות תופיע בלוח היחידתי ותישלח הודעה למושפעים."
                fields={[
                  {
                    name: "confirmed",
                    label: "בדקתי את הפרטים והשיבוצים",
                    type: "checkbox",
                    required: true,
                  },
                ]}
                action={action}
                type="duty.publish"
                payload={{ id }}
                version={duty.version}
              />
            )}
            {(dutyStatus(duty) === "draft" ||
              (dutyStatus(duty) === "published" && future)) && (
              <ActionDialog
                title="ביטול תורנות"
                description={`הביטול יפנה ${assignments.length} שיבוצים וישחרר ${assignments.reduce((sum, item) => sum + num(item.points), 0)} נקודות שמורות. ניקוד נוכחי והיסטוריה יישמרו.`}
                buttonLabel="ביטול תורנות"
                fields={[
                  {
                    name: "reason",
                    label: "סיבת הביטול",
                    type: "textarea",
                    required: true,
                    full: true,
                  },
                  {
                    name: "confirmed",
                    label: "מאשר לבטל ולפנות את השיבוצים",
                    type: "checkbox",
                    required: true,
                  },
                ]}
                action={action}
                type="duty.cancel"
                payload={{ id }}
                version={duty.version}
                danger
              />
            )}
          </div>
        )}
      </Panel>
      <Panel
        title="צוות התורנות"
        subtitle={`${assignments.length} משובצים${slots.length ? ` מתוך ${slots.length} מקומות` : ""}`}
      >
        {slots.length ? (
          slots.map((slot) => {
            const seat = assignments.filter((a) => a.slotId === slot.id);
            // A seat split into execution periods lists every performer by their period.
            if (seat.length > 1 || seat[0]?.performedStart)
              return (
                <div className="slot-row" key={slot.id}>
                  <span className="avatar">
                    <UsersRound size={18} />
                  </span>
                  <span className="grow">
                    <strong>{str(slot.name ?? slot.roleName, "תורן")}</strong>
                    {[...seat]
                      .sort((a, b) =>
                        str(a.performedStart).localeCompare(
                          str(b.performedStart)
                        )
                      )
                      .map((a) => (
                        <small key={a.id}>
                          {personName(state, a.soldierId)} ·{" "}
                          {displayDate(
                            a.performedStart ?? dutyStart(duty),
                            true
                          )}{" "}
                          — {displayDate(a.performedEnd ?? dutyEnd(duty), true)}{" "}
                          · {num(a.points)} נקודות
                        </small>
                      ))}
                  </span>
                  <Badge tone="info">כמה מבצעים</Badge>
                </div>
              );
            const assignment = seat[0];
            return (
              <div className="slot-row" key={slot.id}>
                <span className={`avatar ${assignment ? "" : "empty-avatar"}`}>
                  {assignment ? (
                    personName(state, assignment.soldierId).slice(0, 1)
                  ) : (
                    <UsersRound size={18} />
                  )}
                </span>
                <span className="grow">
                  <strong>
                    {assignment
                      ? personName(state, assignment.soldierId)
                      : "מקום פנוי"}
                  </strong>
                  <small>
                    {str(slot.name ?? slot.roleName, "תורן")}
                    {assignment
                      ? ` · ${num(assignment.points ?? assignment.reservedPoints ?? assignment.score)} נקודות`
                      : ""}
                    {assignment?.performance
                      ? ` · בוצע בפועל: ${personName(state, performanceOf(assignment, duty).performerId)}, ${performanceOf(assignment, duty).points} נקודות`
                      : ""}
                  </small>
                </span>
                {assignment ? (
                  <>
                    <Status value={assignment.status} />
                    {manager && deletedSeats(state, id).includes(assignment) ? (
                      <Badge tone="danger">דחוף: החייל נמחק</Badge>
                    ) : (
                      (assignment.needsReview === true ||
                        (Array.isArray(assignment.needsAttention) &&
                          assignment.needsAttention.length > 0)) && (
                        <Badge tone="warning">דורש טיפול</Badge>
                      )
                    )}
                    {manager &&
                      Array.isArray(assignment.needsAttention) &&
                      assignment.needsAttention.includes("manager") && (
                        <small className="muted">
                          {concernReason(assignment)}
                        </small>
                      )}
                    {manager && <AuditLink id={assignment.id} />}
                  </>
                ) : (
                  manager &&
                  dutyStatus(duty) === "draft" && (
                    <>
                      <ManualAssignment
                        state={state}
                        action={action}
                        duty={duty}
                        slotId={slot.id}
                      />
                      <LotteryButton
                        state={state}
                        action={action}
                        duty={duty}
                        slotId={slot.id}
                      />
                    </>
                  )
                )}
              </div>
            );
          })
        ) : assignments.length ? (
          assignments.map((a) => (
            <div className="slot-row" key={a.id}>
              <span className="avatar">
                {personName(state, a.soldierId).slice(0, 1)}
              </span>
              <strong className="grow">{personName(state, a.soldierId)}</strong>
              <Status value={a.status} />
            </div>
          ))
        ) : (
          <Empty
            title="עדיין אין משובצים"
            text="האחראי יעדכן את צוות התורנות לפני הפרסום."
          />
        )}
      </Panel>
      {manager && (
        <Panel title="תמחור וכללי התאמה">
          <div className="detail-grid">
            <div>
              <small>תעריף בסיס</small>
              <strong>
                {num(
                  obj(duty.pricing).basePoints ??
                    obj(duty.pricing).base ??
                    obj(duty.pricing).amount
                )}{" "}
                נקודות
              </strong>
            </div>
            <div>
              <small>אופן חישוב</small>
              <strong>
                {obj(duty.pricing).mode === "daily" ? "לכל 24 שעות" : "לביצוע"}
              </strong>
            </div>
            <div>
              <small>מנוחה לפני</small>
              <strong>{num(duty.restBeforeMinutes)} דקות</strong>
            </div>
            <div>
              <small>מנוחה אחרי</small>
              <strong>{num(duty.restAfterMinutes)} דקות</strong>
            </div>
          </div>
        </Panel>
      )}
      {manager && (
        <CancellationRequests state={state} action={action} dutyId={id} />
      )}
      {manager &&
        future &&
        ["published", "draft"].includes(str(dutyStatus(duty))) && (
          <DutyChanges state={state} action={action} duty={duty} />
        )}
      {manager && dutyStatus(duty) === "published" && !future && (
        <ExecutionPeriods state={state} action={action} duty={duty} />
      )}
      {manager && dutyStatus(duty) === "published" && !future && (
        <PerformanceCorrections state={state} action={action} duty={duty} />
      )}
      {manager && <ScoreDecisions state={state} action={action} dutyId={id} />}
      {manager && <LotteryHistory state={state} action={action} dutyId={id} />}
    </>
  );
}
