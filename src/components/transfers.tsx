"use client";
import { useState } from "react";
import Link from "next/link";
import {
  type AppState,
  type Action,
  type Row,
  str,
  num,
  rows,
  obj,
  displayDate,
  personName,
} from "@/client/types";
import {
  ActionDialog,
  Empty,
  Form,
  Modal,
  Notice,
  Panel,
  QuickAction,
  Status,
  type Field,
} from "./ui";
import {
  allocationFields,
  allocationSummary,
  allocationValues,
} from "./fixed-allocation";

const OPEN = ["awaiting_consent", "awaiting_manager"];
const candidateLabels: Record<string, string> = {
  pending: "ממתין לתשובה",
  declined: "דחה",
  accepted: "הסכים",
  closed: "נסגר",
};
const transfers = (state: AppState) =>
  state.requests.filter((row) => row.type === "transfer");

/**
 * Offer form on the duty page for the owner of a published seat. After the start the offer
 * still goes out, but a manager sets the handover and approves it (decision 183).
 */
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
  const now = new Date(str(state.serverNow)).getTime();
  if (
    !soldierId ||
    !seat ||
    duty.status !== "published" ||
    new Date(str(seat.performedEnd, str(duty.end))).getTime() <= now
  )
    return null;
  const running = new Date(str(duty.start)).getTime() <= now;
  // One open offer per seat, whether a transfer or a swap.
  const open = state.requests.find(
    (row) =>
      ["transfer", "swap"].includes(str(row.type)) &&
      row.assignmentId === seat.id &&
      OPEN.includes(str(row.status))
  );
  const kind = open?.type === "swap" ? "ההחלפה" : "ההעברה";
  if (open)
    return (
      <Notice>
        {open.status === "awaiting_manager"
          ? `${kind} ממתינה לטיפול אחראי. עד אז השיבוץ שלך בתוקף.`
          : `הצעת ${kind} שלך ממתינה להסכמה. עד להשלמתה השיבוץ שלך בתוקף.`}{" "}
        {open.mailLimited === true &&
          "ההצעה נשמרה באתר; חלק מהמיילים לא נשלחו בגלל המכסה היומית. "}
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
      description={
        running
          ? "התורנות כבר התחילה. אפשר לבקש מחליף: אחרי שיסכים, אחראי יקבע את מועד החילוף, וכל אחד יקבל ניקוד לפי הזמן שביצע. עד אז השיבוץ שלך בתוקף."
          : `אפשר להציע לכמה חיילים. הראשון שיסכים ויעמוד בתנאי התורנות יקבל אותה עם מלוא הניקוד (${num(seat.points)} נקודות). עד אז השיבוץ שלך בתוקף.`
      }
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

function Decision({ row }: { row: Row }) {
  if (row.status === "manager_rejected")
    return <small>{str(row.closedReason)}</small>;
  if (row.status === "cancelled" && row.closedReason)
    return <small>{str(row.closedReason)}</small>;
  if (row.decidedByName && row.status === "completed")
    return <small>ההעברה אושרה בידי {str(row.decidedByName)}</small>;
  return null;
}
const started = (state: AppState, row: Row) => {
  const duty = state.duties.find((item) => item.id === row.dutyId);
  return (
    !!duty &&
    new Date(str(duty.start)).getTime() <=
      new Date(str(state.serverNow)).getTime()
  );
};
function Retract({
  action,
  row,
  label,
  description,
}: {
  action: Action;
  row: Row;
  label: string;
  description: string;
}) {
  return (
    <ActionDialog
      title={label}
      buttonLabel={label}
      description={description}
      fields={[
        {
          name: "confirmed",
          label: "אני מאשר את הביטול",
          type: "checkbox",
          required: true,
        },
      ]}
      action={action}
      type="transfer.withdraw"
      transform={() => ({ id: row.id })}
      version={num(row.version)}
      danger
    />
  );
}

/** Manager decision on a transfer awaiting approval: review, per-exception approval, or a rejection with a reason. */
function TransferDecision({
  state,
  action,
  row,
}: {
  state: AppState;
  action: Action;
  row: Row;
}) {
  const [review, setReview] = useState<Record<string, unknown> | null>(null);
  const [handover, setHandover] = useState("");
  const [allocation, setAllocation] = useState<ReturnType<
    typeof allocationValues
  > | null>(null);
  const [allocationReason, setAllocationReason] = useState("");
  const requirements = rows(review?.requirements);
  const close = () => {
    setReview(null);
    setHandover("");
    setAllocation(null);
    setAllocationReason("");
  };
  const load = async (
    handoverAt?: string,
    shares?: ReturnType<typeof allocationValues>
  ) => {
    const next = await action(
      "transfer.review",
      {
        id: row.id,
        ...(handoverAt && { handoverAt }),
        ...(shares && { allocations: shares }),
      },
      num(row.version)
    );
    setReview(next);
    setAllocation(shares ?? null);
  };
  const reject = (
    <ActionDialog
      title="דחיית ההעברה"
      buttonLabel="דחייה"
      description="ההעברה תיסגר והשיבוץ המקורי יישאר בתוקף. הסיבה תוצג למציע, למחליף ולאחראים, ולכן אין לכתוב בה מידע רגיש."
      fields={[
        {
          name: "reason",
          label: "סיבת הדחייה",
          type: "textarea",
          required: true,
          full: true,
        },
      ]}
      action={action}
      type="transfer.decide"
      payload={{ id: row.id, decision: "reject" }}
      version={num(row.version)}
      danger
    />
  );
  const running = started(state, row);
  return (
    <>
      <button
        className="btn secondary"
        onClick={async () => {
          try {
            await load();
          } catch {
            /* workspace displays API error */
          }
        }}
      >
        בדיקה והחלטה
      </button>
      {reject}
      {review && (
        <Modal
          title={running ? "אישור חילוף בביצוע" : "אישור העברה"}
          onClose={close}
        >
          {!review.valid ? (
            <Notice tone="danger">{str(review.message)}</Notice>
          ) : review.started && !review.handoverAt ? (
            <Form
              fields={[
                {
                  name: "handoverAt",
                  label: "מועד החילוף",
                  type: "datetime-local",
                  required: true,
                  value: handover,
                  hint: `בתוך תקופת הביצוע של ${personName(state, row.fromSoldierId)}: ${displayDate(obj(review.period).start, true)} — ${displayDate(obj(review.period).end, true)}`,
                },
              ]}
              submitLabel="חישוב התקופות"
              onSubmit={async (values) => {
                setHandover(str(values.handoverAt));
                await load(str(values.handoverAt));
              }}
              onCancel={close}
            />
          ) : review.started &&
            obj(review.execution).allocationRequired === true &&
            obj(review.execution).allocationExplicit !== true ? (
            <>
              <Notice>{allocationSummary(obj(review.execution))}</Notice>
              <Form
                fields={[
                  ...allocationFields(obj(review.execution), state, "share"),
                  {
                    name: "allocationReason",
                    label: "סיבה לחלוקת הניקוד",
                    type: "textarea",
                    required: true,
                    full: true,
                  },
                ]}
                submitLabel="חישוב חלוקת הניקוד"
                onSubmit={async (values) => {
                  await load(
                    handover,
                    allocationValues(obj(review.execution), values, "share")
                  );
                  setAllocationReason(str(values.allocationReason));
                }}
                onCancel={close}
              />
            </>
          ) : (
            <>
              {review.started ? (
                <Notice>
                  {personName(state, row.fromSoldierId)} מבצע עד{" "}
                  {displayDate(review.handoverAt, true)}, ו
                  {personName(state, row.acceptedBy)} מחליף אותו מאז ועד סוף
                  התקופה. הניקוד יחושב לכל אחד לפי הזמן שביצע:{" "}
                  {rows(obj(review.execution).changes)
                    .filter((change) => change.kind !== "keep")
                    .map((change) => {
                      const price = obj(change.price);
                      return `${str(change.name)}: בסיס ${str(price.base)}, תוספת קבועה ${str(price.extras, "0")}, סך מדויק ${str(price.totalExact)} ← ${num(price.points)} נקודות`;
                    })
                    .join(" · ")}
                  .
                </Notice>
              ) : (
                <Notice>
                  {personName(state, row.acceptedBy)} יקבל את התורנות{" "}
                  {str(row.dutyName)} עם מלוא הניקוד ({num(row.points)} נקודות),
                  ו{personName(state, row.fromSoldierId)} לא יהיה משובץ לה עוד.
                </Notice>
              )}
              {rows(review.blockers).map((item, index) => (
                <Notice tone="danger" key={index}>
                  {str(item.message)}
                </Notice>
              ))}
              {review.status === "blocked" ? (
                <p className="form-description">
                  המחליף אינו עומד כעת בתנאי התורנות. אפשר לדחות את ההעברה.
                </p>
              ) : (
                <Form
                  fields={[
                    ...requirements.map((item, index): Field => ({
                      name: `approval${index}`,
                      label: str(item.message),
                      type: "checkbox",
                      required: true,
                    })),
                    ...(requirements.length
                      ? [
                          {
                            name: "approvalReason",
                            label: "סיבה לאישור החריגים הנקודתיים",
                            type: "textarea" as const,
                            required: true,
                            full: true,
                            hint: "הסיבה נשמרת אצל האחראים בלבד.",
                          },
                        ]
                      : []),
                    {
                      name: "confirmed",
                      label: "בדקתי את ההתאמה ומאשר את ההעברה",
                      type: "checkbox",
                      required: true,
                    },
                  ]}
                  submitLabel={running ? "אישור החילוף" : "אישור ההעברה"}
                  onSubmit={async (values) => {
                    await action(
                      "transfer.decide",
                      {
                        id: row.id,
                        decision: "approve",
                        confirmed: true,
                        previewToken: review.previewToken,
                        approvalReason: values.approvalReason,
                        approvalKeys: requirements.map((item) => item.key),
                        ...(review.handoverAt ? { handoverAt: handover } : {}),
                        ...(allocation && { allocations: allocation }),
                        ...(allocation && { allocationReason }),
                      },
                      num(row.version)
                    );
                    close();
                  }}
                  onCancel={close}
                />
              )}
            </>
          )}
        </Modal>
      )}
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
                {row.acceptedBy === soldierId && <Decision row={row} />}
              </div>
              <div className="inline">
                <Status value={row.status} />
                {row.status === "awaiting_manager" &&
                  row.acceptedBy === soldierId && (
                    <Retract
                      action={action}
                      row={row}
                      label="ביטול ההסכמה"
                      description="ההעברה תיסגר לפני החלטת האחראי, והתורנות תישאר אצל המציע."
                    />
                  )}
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
                {row.mailLimited === true && (
                  <small>
                    ההצעה נשמרה באתר; חלק מהמיילים לא נשלחו בגלל המכסה היומית.
                  </small>
                )}
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
                ) : (
                  <Decision row={row} />
                )}
              </div>
              <div className="inline">
                <Status value={row.status} />
                {row.status === "awaiting_manager" && (
                  <Retract
                    action={action}
                    row={row}
                    label="ביטול ההעברה"
                    description="ההעברה תיסגר לפני החלטת האחראי, והשיבוץ שלך יישאר בתוקף."
                  />
                )}
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
          subtitle="העברה תקינה לפני התחלה מושלמת בלי אישור אחראי. עד החלטה בהעברה שממתינה לטיפול, השיבוץ המקורי והניקוד השמור בתוקף"
        >
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
                  ) : (
                    <Decision row={row} />
                  )}
                  {rows(row.approvals).length ? (
                    <small>
                      סיבת אישור החריגים: {str(rows(row.approvals)[0].reason)}
                    </small>
                  ) : null}
                </div>
                <div className="inline">
                  <Status value={row.status} />
                  {row.status === "awaiting_manager" && (
                    <TransferDecision state={state} action={action} row={row} />
                  )}
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
