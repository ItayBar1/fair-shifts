"use client";
import Link from "next/link";
import {
  type AppState,
  type Action,
  type Row,
  str,
  num,
  rows,
  displayDate,
  personName,
} from "@/client/types";
import { ActionDialog, Empty, Notice, Panel, QuickAction, Status } from "./ui";

const OPEN = ["awaiting_consent", "awaiting_manager"];
const candidateLabels: Record<string, string> = {
  pending: "ממתין לתשובה",
  declined: "דחה",
  accepted: "הסכים",
  closed: "נסגר",
};
const transfers = (state: AppState) =>
  state.requests.filter((row) => row.type === "transfer");

/** Offer form on the duty page for the owner of a published seat that has not started. */
export function TransferOffer({
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
  if (
    !soldierId ||
    !seat ||
    duty.status !== "published" ||
    new Date(str(duty.start)).getTime() <=
      new Date(str(state.serverNow)).getTime()
  )
    return null;
  const open = transfers(state).find(
    (row) => row.assignmentId === seat.id && OPEN.includes(str(row.status))
  );
  if (open)
    return (
      <Notice>
        {open.status === "awaiting_manager"
          ? "ההעברה ממתינה לטיפול אחראי. עד אז השיבוץ שלך בתוקף."
          : "הצעת ההעברה שלך ממתינה להסכמה. עד להשלמתה השיבוץ שלך בתוקף."}{" "}
        <Link className="text-link" href="/requests">
          למסך ההחלפות
        </Link>
      </Notice>
    );
  const busy = new Set(
    state.assignments
      .filter((row) => row.dutyId === duty.id && row.status !== "cancelled")
      .map((row) => str(row.soldierId))
  );
  const options = state.soldiers
    .filter(
      (row) => !row.deletedAt && row.id !== soldierId && !busy.has(row.id)
    )
    .map((row) => ({ value: row.id, label: str(row.name) }))
    .sort((a, b) => a.label.localeCompare(b.label, "he"));
  return (
    <ActionDialog
      title="הצעת התורנות להעברה"
      buttonLabel="הצעה להעברה"
      description={`אפשר להציע לכמה חיילים. הראשון שיסכים ויעמוד בתנאי התורנות יקבל אותה עם מלוא הניקוד (${num(seat.points)} נקודות). עד אז השיבוץ שלך בתוקף.`}
      fields={[
        {
          name: "candidateIds",
          label: "למי להציע",
          type: "multiselect",
          required: true,
          options,
          full: true,
          hint: "אפשר לבחור כמה חיילים",
        },
      ]}
      action={action}
      type="transfer.offer"
      payload={{ assignmentId: seat.id }}
      version={num(seat.version)}
    />
  );
}

function DutyLine({ state, row }: { state: AppState; row: Row }) {
  const duty = state.duties.find((item) => item.id === row.dutyId);
  return (
    <small>
      {str(row.role, "תורן")} · {num(row.points)} נקודות
      {duty
        ? ` · ${displayDate(duty.start, true)} — ${displayDate(duty.end, true)}`
        : ""}
    </small>
  );
}
function Reasons({ row }: { row: Row }) {
  const reasons = rows(row.managerReasons);
  return (
    <>
      {reasons.map((reason, index) => (
        <small key={index}>{str(reason.message)}</small>
      ))}
    </>
  );
}

export function TransferRequests({
  state,
  action,
}: {
  state: AppState;
  action: Action;
}) {
  const soldierId = state.actor.soldierId;
  const manager = state.actor.role === "manager";
  const all = transfers(state);
  const incoming = all.filter(
    (row) =>
      row.fromSoldierId !== soldierId &&
      rows(row.candidates).some((item) => item.soldierId === soldierId)
  );
  const outgoing = all.filter((row) => row.fromSoldierId === soldierId);
  return (
    <>
      <Panel
        title="הצעות שקיבלתי"
        subtitle="הסכמה מעבירה אליך את התורנות ואת מלוא הניקוד שלה"
      >
        {incoming.length ? (
          incoming.map((row) => (
            <article className="task-item" key={row.id}>
              <div className="grow">
                <strong>
                  {str(row.dutyName)} — מאת{" "}
                  {personName(state, row.fromSoldierId)}
                </strong>
                <DutyLine state={state} row={row} />
                {row.acceptedBy === soldierId && <Reasons row={row} />}
              </div>
              <div className="inline">
                <Status value={row.status} />
                {row.status === "awaiting_consent" && (
                  <>
                    <ActionDialog
                      title="קבלת התורנות"
                      buttonLabel="הסכמה"
                      description="התנאים ייבדקו שוב עכשיו. אם הכול תקין והתורנות טרם התחילה, היא תועבר אליך מיד עם מלוא הניקוד."
                      fields={[
                        {
                          name: "confirmed",
                          label: "אני מסכים לקבל את התורנות",
                          type: "checkbox",
                          required: true,
                        },
                      ]}
                      action={action}
                      type="transfer.respond"
                      payload={{ id: row.id, decision: "accept" }}
                      version={row.version}
                    />
                    <QuickAction
                      action={action}
                      type="transfer.respond"
                      payload={{ id: row.id, decision: "decline" }}
                      version={row.version}
                    >
                      דחייה
                    </QuickAction>
                  </>
                )}
              </div>
            </article>
          ))
        ) : (
          <Empty title="אין הצעות שהתקבלו" />
        )}
      </Panel>
      <Panel
        title="הצעות ששלחתי"
        subtitle="אפשר להציע תורנות להעברה מדף התורנות"
      >
        {outgoing.length ? (
          outgoing.map((row) => (
            <article className="task-item" key={row.id}>
              <div className="grow">
                <strong>{str(row.dutyName)}</strong>
                <DutyLine state={state} row={row} />
                <small>
                  {rows(row.candidates)
                    .map(
                      (item) =>
                        `${personName(state, item.soldierId)}: ${candidateLabels[str(item.status)] ?? str(item.status)}`
                    )
                    .join(" · ")}
                </small>
                {row.closedReason ? (
                  <small>{str(row.closedReason)}</small>
                ) : null}
              </div>
              <div className="inline">
                <Status value={row.status} />
                {row.status === "awaiting_consent" && (
                  <QuickAction
                    action={action}
                    type="transfer.withdraw"
                    payload={{ id: row.id }}
                    version={row.version}
                  >
                    ביטול ההצעה
                  </QuickAction>
                )}
              </div>
            </article>
          ))
        ) : (
          <Empty title="לא שלחת הצעות העברה" />
        )}
      </Panel>
      {manager && (
        <Panel
          title="העברות ביחידה"
          subtitle="העברה תקינה לפני התחלה מושלמת בלי אישור אחראי"
        >
          {all.some((row) => row.status === "awaiting_manager") && (
            <Notice tone="warning">
              החלטת אחראי בהעברה שממתינה לטיפול תתווסף בהמשך. עד אז השיבוץ
              המקורי והניקוד השמור נשארים בתוקף.
            </Notice>
          )}
          {all.length ? (
            all.map((row) => (
              <article className="task-item" key={row.id}>
                <div className="grow">
                  <strong>
                    {str(row.dutyName)}: {personName(state, row.fromSoldierId)}
                    {row.acceptedBy
                      ? ` ← ${personName(state, row.acceptedBy)}`
                      : ""}
                  </strong>
                  <DutyLine state={state} row={row} />
                  <Reasons row={row} />
                  {row.closedReason ? (
                    <small>{str(row.closedReason)}</small>
                  ) : null}
                </div>
                <div className="inline">
                  <Status value={row.status} />
                </div>
              </article>
            ))
          ) : (
            <Empty title="אין העברות" />
          )}
        </Panel>
      )}
    </>
  );
}
