"use client";
import Link from "next/link";
import {
  type AppState,
  type Action,
  type Row,
  str,
  num,
  obj,
  rows,
  displayDate,
  personName,
} from "@/client/types";
import { ActionDialog, Empty, Notice, Panel, QuickAction, Status } from "./ui";

const kindLabels: Record<string, string> = {
  cancel: "ביטול",
  postpone: "דחייה",
};
const outcomeLabels: Record<string, string> = {
  rejected: "הבקשה נדחתה",
  removed: "החייל הוסר מהשיבוץ בעדכון שפורסם",
  rescheduled: "מועד התורנות שונה בעדכון שפורסם",
  duty_cancelled: "התורנות בוטלה",
  referred: "הופנתה לטיפול בביצוע בפועל",
};
const requestsOf = (state: AppState) =>
  state.requests.filter((row) => row.type === "cancellation");
const started = (state: AppState, duty: Row | undefined) =>
  !duty ||
  new Date(str(duty.start)).getTime() <=
    new Date(str(state.serverNow)).getTime();
const reasonField = (label: string) => ({
  name: "reason",
  label,
  type: "textarea" as const,
  required: true,
  full: true,
});

/** Request form on the duty page for the owner of a published seat that has not started. */
export function CancellationRequestButton({
  state,
  action,
  duty,
}: {
  state: AppState;
  action: Action;
  duty: Row;
}) {
  const soldierId = state.actor.soldierId;
  const seat = state.assignments.find(
    (row) =>
      row.dutyId === duty.id &&
      row.soldierId === soldierId &&
      row.status === "reserved"
  );
  if (!soldierId || !seat || duty.status !== "published") return null;
  if (started(state, duty))
    return (
      <Notice>
        התורנות כבר התחילה, ולכן אי אפשר לבקש ביטול או דחייה. אפשר לבקש מחליף,
        והאחראי יקבע את מועד החילוף.
      </Notice>
    );
  const open = requestsOf(state).find(
    (row) => row.dutyId === duty.id && row.status === "pending"
  );
  if (open)
    return (
      <Notice>
        בקשת ה{kindLabels[str(open.kind)]} שלך ממתינה להחלטת אחראי. עד להחלטה
        השיבוץ והניקוד השמור נשארים בתוקף.{" "}
        <Link className="text-link" href="/requests">
          למסך הבקשות
        </Link>
      </Notice>
    );
  return (
    <ActionDialog
      title="בקשת ביטול או דחייה"
      buttonLabel="בקשת ביטול או דחייה"
      description="הבקשה תועבר לאחראי התורנויות. היא אינה מבטלת את השיבוץ: עד להחלטת האחראי השיבוץ והניקוד השמור נשארים בתוקף."
      fields={[
        {
          name: "kind",
          label: "מה מבקשים",
          type: "select",
          required: true,
          value: "cancel",
          options: [
            { value: "cancel", label: "ביטול השיבוץ שלי" },
            { value: "postpone", label: "דחייה למועד אחר" },
          ],
        },
        reasonField("סיבת הבקשה, למשל פטור שלדעתך חל עליך"),
      ]}
      action={action}
      type="cancellation.submit"
      payload={{ assignmentId: seat.id }}
      version={num(seat.version)}
    />
  );
}

function RequestLine({ state, row }: { state: AppState; row: Row }) {
  const duty = state.duties.find((item) => item.id === row.dutyId);
  return (
    <>
      <small>
        {str(row.role, "תורן")} · {num(row.points)} נקודות ·{" "}
        {displayDate(duty?.start ?? row.dutyStart, true)} —{" "}
        {displayDate(duty?.end ?? row.dutyEnd, true)}
      </small>
      <small>סיבת הבקשה: {str(row.reason)}</small>
    </>
  );
}
function Decision({ row, manager }: { row: Row; manager: boolean }) {
  const decision = obj(row.decision);
  if (!decision.outcome)
    return row.closedReason ? <small>{str(row.closedReason)}</small> : null;
  return (
    <small>
      {outcomeLabels[str(decision.outcome)] ?? str(decision.outcome)}:{" "}
      {str(decision.reason)} · {displayDate(decision.decidedAt, true)}
      {manager && decision.deciderName
        ? ` · החליט/ה: ${str(decision.deciderName)}`
        : ""}
      {decision.outcome === "removed" || decision.outcome === "rescheduled" ? (
        <>
          {" "}
          <Link className="text-link" href={`/duties/${str(row.dutyId)}`}>
            לדף התורנות
          </Link>
        </>
      ) : null}
    </small>
  );
}

/** Manager actions for one pending request: through update-and-publish, cancellation, or rejection. */
function ManagerActions({
  state,
  action,
  row,
}: {
  state: AppState;
  action: Action;
  row: Row;
}) {
  const duty = state.duties.find((item) => item.id === row.dutyId);
  const reject = (
    <ActionDialog
      title="דחיית הבקשה"
      buttonLabel="דחיית הבקשה"
      description="השיבוץ והניקוד השמור נשארים בתוקף. החייל יקבל את הסיבה."
      fields={[reasonField("סיבת הדחייה")]}
      action={action}
      type="cancellation.reject"
      payload={{ id: row.id }}
      version={row.version}
    />
  );
  if (started(state, duty))
    return (
      <div className="request-actions">
        <Notice tone="warning">
          התורנות כבר התחילה. אי אפשר לבטל או לדחות אותה כעת, גם לא בבקשה. את
          הביצוע בפועל מתעדים בתקופות הביצוע, ולאחר הסיום אפשר גם בתיקון ביצוע
          בדף התורנות.
        </Notice>
        <div className="inline">
          <ActionDialog
            title="הפניה לטיפול בביצוע"
            buttonLabel="הפניה לטיפול בביצוע"
            description="הבקשה תיסגר, והחייל יקבל הודעה שהטיפול יהיה בביצוע בפועל. השיבוץ אינו משתנה."
            fields={[reasonField("הסבר לחייל")]}
            action={action}
            type="cancellation.refer"
            payload={{ id: row.id }}
            version={row.version}
          />
          {reject}
        </div>
      </div>
    );
  const change = rows(state.dutyChanges).find(
    (item) => item.requestId === row.id && item.status === "open"
  );
  const assigned = state.assignments.filter(
    (item) => item.dutyId === row.dutyId && item.status === "reserved"
  );
  return (
    <div className="request-actions">
      {change ? (
        <Notice>
          נפתחה הצעת שינוי לבקשה. בדקו את ההשפעה ופרסמו אותה ב״עדכן ופרסם״ בדף
          התורנות. עד אז השיבוץ בתוקף.{" "}
          <Link className="text-link" href={`/duties/${str(row.dutyId)}`}>
            להצעת השינוי
          </Link>
        </Notice>
      ) : null}
      <div className="inline">
        {!change && (
          <>
            <ActionDialog
              title="הסרת החייל מהמקום"
              buttonLabel="הכנת הסרה מהמקום"
              description="תיפתח הצעת שינוי שבה המקום של החייל פנוי. אפשר לבחור בה מחליף. ההסרה תחול רק אחרי בדיקת ההשפעה ו״עדכן ופרסם״, ואז ישתחרר גם הניקוד השמור."
              fields={[reasonField("סיבת השינוי")]}
              action={action}
              type="cancellation.prepare"
              payload={{ id: row.id, outcome: "remove" }}
              version={row.version}
            />
            <ActionDialog
              title="דחיית התורנות למועד אחר"
              buttonLabel="הכנת שינוי מועד"
              description="תיפתח הצעת שינוי לכל התורנות. בוחרים בה מועד חדש, וההתאמה של כל המשובצים נבדקת מחדש לפני ״עדכן ופרסם״."
              fields={[reasonField("סיבת השינוי")]}
              action={action}
              type="cancellation.prepare"
              payload={{ id: row.id, outcome: "reschedule" }}
              version={row.version}
            />
          </>
        )}
        {duty && (
          <ActionDialog
            title="ביטול כל התורנות"
            buttonLabel="ביטול התורנות"
            description={`הביטול יפנה ${assigned.length} שיבוצים (${assigned.map((item) => personName(state, item.soldierId)).join(", ")}) וישחרר ${assigned.reduce((sum, item) => sum + num(item.points), 0)} נקודות שמורות. כל המשובצים יקבלו הודעה, וכל בקשה פתוחה לתורנות תסומן כהושלמה.`}
            fields={[
              reasonField("סיבת הביטול"),
              {
                name: "confirmed",
                label: "מאשר לבטל את כל התורנות ולפנות את השיבוצים",
                type: "checkbox",
                required: true,
              },
            ]}
            action={action}
            type="duty.cancel"
            payload={{ id: duty.id, requestId: row.id }}
            version={num(duty.version)}
            danger
          />
        )}
        {reject}
      </div>
    </div>
  );
}

export function CancellationRequests({
  state,
  action,
  dutyId,
}: {
  state: AppState;
  action: Action;
  dutyId?: string;
}) {
  const manager = state.actor.role === "manager";
  const all = requestsOf(state).filter(
    (row) => !dutyId || row.dutyId === dutyId
  );
  const list = manager
    ? all
    : all.filter((row) => row.soldierId === state.actor.soldierId);
  const ordered = [...list].sort(
    (a, b) =>
      Number(b.status === "pending") - Number(a.status === "pending") ||
      str(b.createdAt).localeCompare(str(a.createdAt))
  );
  if (dutyId && !ordered.some((row) => row.status === "pending")) return null;
  const shown = dutyId
    ? ordered.filter((row) => row.status === "pending")
    : ordered;
  return (
    <Panel
      title={manager ? "בקשות ביטול ודחייה" : "בקשות הביטול והדחייה שלי"}
      subtitle={
        manager
          ? "הגשת בקשה אינה משנה שיבוץ. ההחלטה חלה רק אחרי עדכן ופרסם או ביטול התורנות"
          : "אפשר לבקש מדף התורנות, לפני תחילתה. השיבוץ בתוקף עד החלטת האחראי"
      }
    >
      {shown.length ? (
        shown.map((row) => (
          <article className="task-item" key={row.id}>
            <div className="grow">
              <strong>
                בקשת {kindLabels[str(row.kind)]} — {str(row.dutyName)}
                {manager ? ` · ${personName(state, row.soldierId)}` : ""}
              </strong>
              <RequestLine state={state} row={row} />
              <Decision row={row} manager={manager} />
              {manager && row.status === "pending" && (
                <ManagerActions state={state} action={action} row={row} />
              )}
            </div>
            <div className="inline">
              <Status value={row.status} />
              {!manager && row.status === "pending" && (
                <QuickAction
                  action={action}
                  type="cancellation.withdraw"
                  payload={{ id: row.id }}
                  version={row.version}
                >
                  ביטול הבקשה
                </QuickAction>
              )}
            </div>
          </article>
        ))
      ) : (
        <Empty title={manager ? "אין בקשות ביטול או דחייה" : "לא הגשת בקשות"} />
      )}
    </Panel>
  );
}
