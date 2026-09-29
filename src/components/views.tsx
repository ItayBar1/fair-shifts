"use client";
import { DutyChanges } from "./duty-changes";
import Link from "next/link";
import { useState } from "react";
import { ManualAssignment } from "./manual-assignment";
import {
  PerformanceCorrections,
  performanceOf,
} from "./performance-corrections";
import { LotteryButton, LotteryHistory } from "./planning";
import { ScoreDecisions } from "./score-decisions";
import { TransferOffer } from "./transfers";
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
  onBoard,
  overlapsMonth,
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
}: {
  label: string;
  value: React.ReactNode;
  detail: string;
  icon: typeof CalendarDays;
  tone?: string;
}) {
  return (
    <div className="stat">
      <div className="stat-top">
        <span>{label}</span>
        <span className={`stat-icon ${tone}`}>
          <Icon size={20} />
        </span>
      </div>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}
export function CalendarView({ state }: { state: AppState }) {
  const [onlyMine, setOnlyMine] = useState(false);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"list" | "month">("month");
  const [month, setMonth] = useState(() =>
    monthOf(str(state.serverNow, new Date().toISOString()))
  );
  const now = new Date().toISOString();
  const ownIds = new Set(
    state.assignments
      .filter(
        (a) =>
          a.soldierId === state.actor.soldierId &&
          !["cancelled", "transferred"].includes(str(a.status))
      )
      .map((a) => str(a.dutyId))
  );
  const visible = state.duties
    .filter(onBoard)
    .filter(
      (d) => (!onlyMine || ownIds.has(d.id)) && str(d.name).includes(query)
    );
  const monthDuties = visible
    .filter((d) => overlapsMonth(d, month))
    .sort((a, b) => dutyStart(a).localeCompare(dutyStart(b)));
  const activeMonth = monthDuties.filter((d) => !isCancelled(d));
  const upcoming = visible.filter(
    (d) => !isCancelled(d) && new Date(dutyEnd(d)) >= new Date()
  ).length;
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
          value={activeMonth.length}
          detail="מפורסמות בלוח היחידתי"
          icon={CalendarDays}
        />
        <Stat
          label="התורנויות שלי"
          value={activeMonth.filter((d) => ownIds.has(d.id)).length}
          detail="בחודש המוצג"
          icon={UsersRound}
          tone="blue"
        />
        <Stat
          label="בהמשך הדרך"
          value={upcoming}
          detail="תורנויות שטרם הסתיימו"
          icon={Clock3}
          tone="amber"
        />
        <Stat
          label="הניקוד שלי"
          value={num(
            state.soldiers.find((s) => s.id === state.actor.soldierId)
              ?.currentScore ??
              state.soldiers.find((s) => s.id === state.actor.soldierId)?.score
          )}
          detail="נקודות שכבר נזקפו"
          icon={Scale}
          tone="violet"
        />
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
            <div className="segmented">
              <button
                aria-pressed={!onlyMine}
                className={!onlyMine ? "selected" : ""}
                onClick={() => setOnlyMine(false)}
              >
                כל היחידה
              </button>
              <button
                aria-pressed={onlyMine}
                className={onlyMine ? "selected" : ""}
                onClick={() => setOnlyMine(true)}
              >
                התורנויות שלי
              </button>
            </div>
            <div className="segmented">
              <button
                className={mode === "month" ? "selected" : ""}
                onClick={() => setMode("month")}
                aria-label="תצוגת חודש"
              >
                <CalendarDays size={17} />
              </button>
              <button
                className={mode === "list" ? "selected" : ""}
                onClick={() => setMode("list")}
                aria-label="תצוגת רשימה"
              >
                <Filter size={17} />
              </button>
            </div>
          </div>
        </div>
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
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("");
  const sorted = [...state.soldiers]
    .filter((s) => !s.deletedAt)
    .sort(
      (a, b) =>
        num(a.currentScore ?? a.score) - num(b.currentScore ?? b.score) ||
        str(a.name).localeCompare(str(b.name), "he")
    );
  const ranked: (Row & { rank: number })[] = sorted.map((s) => ({
    ...s,
    rank:
      sorted.findIndex(
        (other) =>
          num(other.currentScore ?? other.score) ===
          num(s.currentScore ?? s.score)
      ) + 1,
  }));
  const filtered = ranked.filter(
    (s) => str(s.name).includes(search) && (!filter || s.population === filter)
  );
  return (
    <>
      <Notice>
        הטבלה מציגה נקודות מביצועים שכבר הסתיימו. שיבוצים עתידיים נשמרים בנפרד
        ונכללים בבחירת המועמדים.
      </Notice>
      <Panel
        title="טבלת הצדק היחידתית"
        subtitle={`${sorted.length} חיילים · יתרה זהה מקבלת דירוג משותף`}
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
        {filtered.length ? (
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
export function Dashboard({
  state,
  action,
}: {
  state: AppState;
  action: Action;
}) {
  const drafts = state.duties.filter((d) => dutyStatus(d) === "draft");
  const pending = state.constraints.filter((c) => c.status === "pending");
  const requests = state.requests.filter(
    (r) =>
      ![
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
  const concerns = state.assignments.filter(
    (a) =>
      ["reserved", "held"].includes(str(a.status)) &&
      (a.needsReview ||
        (Array.isArray(a.needsAttention) && a.needsAttention.length > 0))
  );
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
          value={pending.length + requests.length + decisions.length}
          detail="אילוצים, החלפות, בקשות ותיקוני יתרה"
          icon={Clock3}
          tone="amber"
        />
        <Stat
          label="שיבוצים לטיפול"
          value={concerns.length}
          detail="נדרשת בדיקת אחראי"
          icon={AlertTriangle}
          tone="violet"
        />
      </div>
      <div className="two-columns">
        <Panel title="על סדר היום" subtitle="החלטות שיקדמו את התכנון">
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
          {concerns.map((a) => (
            <Link className="task-item" href={`/duties/${a.dutyId}`} key={a.id}>
              <span className="task-symbol amber">
                <AlertTriangle size={20} />
              </span>
              <span>
                <strong>
                  {personName(state, a.soldierId)} — שיבוץ דורש טיפול
                </strong>
                <small>
                  {str(a.reviewReason, "הנתונים השתנו לאחר השיבוץ")}
                </small>
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
        <CancellationRequestButton state={state} action={action} duty={duty} />
        {manager && (
          <div className="panel-actions">
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
            const assignment = assignments.find((a) => a.slotId === slot.id);
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
                    {assignment.needsReview === true && (
                      <Badge tone="warning">דורש טיפול</Badge>
                    )}
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
        <PerformanceCorrections state={state} action={action} duty={duty} />
      )}
      {manager && <ScoreDecisions state={state} action={action} dutyId={id} />}
      {manager && <LotteryHistory state={state} action={action} dutyId={id} />}
    </>
  );
}
