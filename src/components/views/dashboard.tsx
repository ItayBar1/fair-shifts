"use client";
import Link from "next/link";
import { ScoreDecisions } from "../score-decisions";
import { ManagerReturns } from "../manager-returns";
import { referredRequests } from "../execution-periods";
import { deletedSeats } from "@/client/deleted-seats";
import {
  CalendarDays,
  UsersRound,
  Clock3,
  ChevronLeft,
  ArrowLeft,
  AlertTriangle,
  UserX,
  Scale,
  Upload,
} from "lucide-react";
import {
  type AppState,
  type Action,
  type Row,
  str,
  rows,
  personName,
  displayDate,
  dutyName,
} from "@/client/types";
import { Empty, Panel, QuickAction, scrollRegion } from "../ui";
import { DutyList } from "./calendar";
import { dutyStatus } from "./duty-helpers";
import { Stat } from "./stat";

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
export function concernReason(assignment: Row) {
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
  // The agenda lists only what waits for a decision; an idle unit says so once.
  // Drafts are listed once, in their own section below (decision 241).
  const waiting =
    urgent.length +
    transfers.length +
    swaps.length +
    referred.length +
    departed.length +
    concerns.length +
    pending.length +
    requests.length;
  return (
    <>
      {/* Shortcuts carry the menu's own names and marks (decision 241). */}
      <nav className="quick-actions" aria-label="פעולות מהירות">
        <Link className="btn secondary" href="/manage/planning">
          <CalendarDays size={16} aria-hidden="true" /> תכנון ושיבוץ
        </Link>
        <Link className="btn secondary" href="/manage/soldiers">
          <UsersRound size={16} aria-hidden="true" /> חיילי היחידה
        </Link>
        <Link className="btn secondary" href="/manage/imports">
          <Upload size={16} aria-hidden="true" /> ייבוא חיילים
        </Link>
        <Link className="btn secondary" href="/fairness">
          <Scale size={16} aria-hidden="true" /> טבלת הצדק
        </Link>
      </nav>
      <div className="stats-grid" {...scrollRegion("מדדי מרכז הטיפול")}>
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
      <Panel title="על סדר היום" subtitle="מה מחכה להחלטה, הדחוף ראשון">
        {waiting === 0 && (
          <Empty
            title="אין כרגע החלטות ממתינות"
            text="בקשות, אילוצים ושיבוצים שידרשו החלטה יופיעו כאן."
          />
        )}
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
        {pending.length > 0 && (
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
        )}
        {requests.length > 0 && (
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
        )}
        {transfers.map((r) => (
          <Link className="task-item" href="/requests" key={r.id}>
            <span className="task-symbol amber">
              <Clock3 size={20} />
            </span>
            <span>
              <strong>העברה ממתינה להחלטה: {str(r.dutyName)}</strong>
              <small>
                {personName(state, r.fromSoldierId)} ←{" "}
                {personName(state, r.acceptedBy)}. עד ההחלטה השיבוץ המקורי בתוקף
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
                  {personName(state, r.acceptedBy)}. עד ההחלטה השיבוצים המקוריים
                  בתוקף
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
                בקשת {personName(state, r.soldierId)} הופנתה אחרי תחילת התורנות.
                יש לרשום את תקופות הביצוע של המקום
              </small>
            </span>
            <ChevronLeft size={18} />
          </Link>
        ))}
        {departed.map((s) => {
          const notice = rows(state.departures).find(
            (row) => row.subjectId === s.id && row.releaseDate === s.releaseDate
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
      {decisions.length > 0 && <ScoreDecisions state={state} action={action} />}
      {returns.length > 0 && <ManagerReturns state={state} action={action} />}
      <Panel
        title="טיוטות משותפות"
        subtitle={
          drafts.length
            ? `${drafts.length} טיוטות, עדיין לא גלויות לחיילים`
            : undefined
        }
        actions={
          <Link href="/manage/publish" className="text-link">
            לפרסום הטיוטות <ArrowLeft size={15} />
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
