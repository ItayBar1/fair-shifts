"use client";
import { useState } from "react";
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
const entryLabels: Record<string, string> = {
  pending: "ממתין לתשובה",
  declined: "דחה",
  accepted: "הסכים",
  closed: "נסגר",
};
const swaps = (state: AppState) =>
  state.requests.filter((row) => row.type === "swap");
const future = (state: AppState, duty?: Row) =>
  !!duty &&
  new Date(str(duty.start)).getTime() >
    new Date(str(state.serverNow)).getTime();
const dutyOf = (state: AppState, id: unknown) =>
  state.duties.find((item) => item.id === id);
/** A seat can still change hands until its own period ends; after the start only through a manager. */
const open = (state: AppState, seat: Row, duty?: Row) =>
  !!duty &&
  new Date(str(seat.performedEnd, str(duty.end))).getTime() >
    new Date(str(state.serverNow)).getTime();

/** Offer form on the duty page: swap my seat for one of several seats of other soldiers. */
export function SwapOffer({
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
    !open(state, seat, duty) ||
    state.requests.some(
      (row) =>
        ["transfer", "swap"].includes(str(row.type)) &&
        row.assignmentId === seat.id &&
        OPEN.includes(str(row.status))
    )
  )
    return null;
  const options = state.assignments
    .filter((row) => {
      const other = dutyOf(state, row.dutyId);
      return (
        row.status === "reserved" &&
        row.soldierId !== soldierId &&
        other?.status === "published" &&
        open(state, row, other) &&
        // Two seats of one started duty cannot be swapped.
        (future(state, other) || other.id !== duty.id) &&
        // A soldier's list has no managers (decision 192), so a seat held by one is not on offer.
        state.soldiers.some(
          (item) => item.id === row.soldierId && !item.deletedAt
        )
      );
    })
    .map((row) => {
      const other = dutyOf(state, row.dutyId)!;
      const role = rows(other.slots).find((slot) => slot.id === row.slotId);
      return {
        value: row.id,
        start: str(other.start),
        label: `${personName(state, row.soldierId)} — ${str(other.name)} · ${str(role?.name, "תורן")} · ${displayDate(other.start, true)} · ${num(row.points)} נקודות`,
      };
    })
    .sort(
      (a, b) =>
        a.start.localeCompare(b.start) || a.label.localeCompare(b.label, "he")
    )
    .map(({ value, label }) => ({ value, label }));
  if (!options.length) return null;
  return (
    <ActionDialog
      title="הצעת החלפה"
      buttonLabel="הצעת החלפה"
      description={`בחרו שיבוץ אחד או כמה של חיילים אחרים. הראשון שיסכים יקבל את התורנות שלך (${num(seat.points)} נקודות), ואת/ה תקבל/י את התורנות שלו עם הניקוד שלה. שני השיבוצים מתחלפים יחד או לא מתחלפים כלל, ועד אז השיבוץ שלך בתוקף.${future(state, duty) ? "" : " התורנות שלך כבר התחילה: אחרי ההסכמה אחראי יקבע את מועד החילוף, והניקוד בה יחושב לפי הזמן שכל אחד ביצע."}`}
      fields={[
        {
          name: "targetAssignmentIds",
          label: "עם אילו שיבוצים להחליף",
          type: "multiselect",
          required: true,
          options,
          full: true,
          hint: "אפשר לבחור כמה שיבוצים",
        },
      ]}
      action={action}
      type="swap.offer"
      payload={{ assignmentId: seat.id }}
      version={num(seat.version)}
    />
  );
}

function EntryLine({ state, entry }: { state: AppState; entry: Row }) {
  const duty = dutyOf(state, entry.dutyId);
  return (
    <small>
      {str(entry.dutyName)} · {str(entry.role, "תורן")} · {num(entry.points)}{" "}
      נקודות
      {duty
        ? ` · ${displayDate(duty.start, true)} — ${displayDate(duty.end, true)}`
        : ""}
    </small>
  );
}
function Reasons({ row }: { row: Row }) {
  return (
    <>
      {rows(row.managerReasons).map((reason, index) => (
        <small key={index}>{str(reason.message)}</small>
      ))}
    </>
  );
}
function Outcome({ row }: { row: Row }) {
  if (row.closedReason) return <small>{str(row.closedReason)}</small>;
  if (row.decidedByName && row.status === "completed")
    return <small>ההחלפה אושרה בידי {str(row.decidedByName)}</small>;
  return null;
}
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
      type="swap.withdraw"
      transform={() => ({ id: row.id })}
      version={num(row.version)}
      danger
    />
  );
}

/** Manager decision on a swap awaiting approval: review of both sides, per-exception approval, or rejection. */
function SwapDecision({
  state,
  action,
  row,
}: {
  state: AppState;
  action: Action;
  row: Row;
}) {
  const [review, setReview] = useState<Record<string, unknown> | null>(null);
  const [times, setTimes] = useState<Record<string, string>>({});
  const [allocationSides, setAllocationSides] = useState<
    | { slotId: string; allocations: ReturnType<typeof allocationValues> }[]
    | null
  >(null);
  const [allocationReason, setAllocationReason] = useState("");
  const sides = rows(review?.sides);
  const needsAllocation = sides.flatMap((side, index) => {
    const execution = obj(side.execution);
    return execution.allocationRequired === true &&
      execution.allocationExplicit !== true
      ? [{ execution, index }]
      : [];
  });
  const requirements = sides.flatMap((side) =>
    rows(side.requirements).map((item): Row => ({
      ...item,
      sideId: side.soldierId,
    }))
  );
  const close = () => {
    setReview(null);
    setTimes({});
    setAllocationSides(null);
    setAllocationReason("");
  };
  const load = async (
    handovers: Record<string, string> = {},
    shares?: {
      slotId: string;
      allocations: ReturnType<typeof allocationValues>;
    }[]
  ) => {
    const next = await action(
      "swap.review",
      { id: row.id, ...handovers, ...(shares && { allocationSides: shares }) },
      num(row.version)
    );
    setReview(next);
    setAllocationSides(shares ?? null);
  };
  const accepted = rows(row.candidates).find(
    (item) => item.assignmentId === row.acceptedAssignmentId
  );
  const reject = (
    <ActionDialog
      title="דחיית ההחלפה"
      buttonLabel="דחייה"
      description="ההחלפה תיסגר ושני השיבוצים המקוריים יישארו בתוקף. הסיבה תוצג לשני החיילים ולאחראים, ולכן אין לכתוב בה מידע רגיש."
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
      type="swap.decide"
      payload={{ id: row.id, decision: "reject" }}
      version={num(row.version)}
      danger
    />
  );
  const periods = obj(review?.periods);
  const handoverFields: Field[] = [
    ...(periods.seat
      ? [
          {
            name: "handoverAt",
            label: `מועד החילוף ב${str(row.dutyName)}`,
            type: "datetime-local" as const,
            required: true,
            value: times.handoverAt,
            hint: `בתוך תקופת הביצוע של ${personName(state, row.fromSoldierId)}: ${displayDate(obj(periods.seat).start, true)} — ${displayDate(obj(periods.seat).end, true)}`,
          },
        ]
      : []),
    ...(periods.target
      ? [
          {
            name: "targetHandoverAt",
            label: `מועד החילוף ב${str(accepted?.dutyName)}`,
            type: "datetime-local" as const,
            required: true,
            value: times.targetHandoverAt,
            hint: `בתוך תקופת הביצוע של ${personName(state, accepted?.soldierId)}: ${displayDate(obj(periods.target).start, true)} — ${displayDate(obj(periods.target).end, true)}`,
          },
        ]
      : []),
  ];
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
        <Modal title="אישור החלפה" onClose={close}>
          {!review.valid ? (
            <Notice tone="danger">{str(review.message)}</Notice>
          ) : review.handoverRequired ? (
            <Form
              fields={handoverFields}
              submitLabel="חישוב התקופות"
              onSubmit={async (values) => {
                const next = Object.fromEntries(
                  Object.entries(values).map(([key, value]) => [
                    key,
                    str(value),
                  ])
                );
                setTimes(next);
                await load(next);
              }}
              onCancel={close}
            />
          ) : needsAllocation.length > 0 ? (
            <>
              {needsAllocation.map(({ execution, index }) => (
                <Notice key={index}>
                  {str(sides[index]?.dutyName)}: {allocationSummary(execution)}
                </Notice>
              ))}
              <Form
                fields={[
                  ...needsAllocation.flatMap(({ execution, index }) =>
                    allocationFields(execution, state, `share${index}-`)
                  ),
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
                    times,
                    needsAllocation.map(({ execution, index }) => ({
                      slotId: str(execution.slotId),
                      allocations: allocationValues(
                        execution,
                        values,
                        `share${index}-`
                      ),
                    }))
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
                  אחת התורנויות כבר התחילה. בתורנות שהתחילה כל אחד מקבל ניקוד
                  לפי הזמן שביצע:{" "}
                  {sides
                    .flatMap((side) => rows(obj(side.execution).changes))
                    .filter((change) => change.kind !== "keep")
                    .map((change) => {
                      const price = obj(change.price);
                      return `${str(change.name)}: בסיס ${str(price.base)}, תוספת קבועה ${str(price.extras, "0")}, סך מדויק ${str(price.totalExact)} ← ${num(price.points)} נקודות`;
                    })
                    .join(" · ")}
                  . תורנות שטרם התחילה עוברת במלואה.
                </Notice>
              ) : (
                <Notice>
                  {personName(state, accepted?.soldierId)} יקבל את{" "}
                  {str(row.dutyName)} ({num(row.points)} נקודות), ו
                  {personName(state, row.fromSoldierId)} יקבל את{" "}
                  {str(accepted?.dutyName)} ({num(accepted?.points)} נקודות).
                  שני השיבוצים מתחלפים יחד.
                </Notice>
              )}
              {sides.flatMap((side) =>
                rows(side.blockers).map((item, index) => (
                  <Notice tone="danger" key={`${str(side.soldierId)}-${index}`}>
                    {personName(state, side.soldierId)}: {str(item.message)}
                  </Notice>
                ))
              )}
              {review.status === "blocked" ? (
                <p className="form-description">
                  אחד הצדדים אינו עומד כעת בתנאי התורנות. אפשר לדחות את ההחלפה.
                </p>
              ) : (
                <Form
                  fields={[
                    ...requirements.map((item, index): Field => ({
                      name: `approval${index}`,
                      label: `${personName(state, item.sideId)}: ${str(item.message)}`,
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
                      label: "בדקתי את ההתאמה של שני הצדדים ומאשר את ההחלפה",
                      type: "checkbox",
                      required: true,
                    },
                  ]}
                  submitLabel="אישור ההחלפה"
                  onSubmit={async (values) => {
                    await action(
                      "swap.decide",
                      {
                        id: row.id,
                        decision: "approve",
                        confirmed: true,
                        previewToken: review.previewToken,
                        approvalReason: values.approvalReason,
                        approvalKeys: requirements.map((item) => item.key),
                        ...times,
                        ...(allocationSides && { allocationSides }),
                        ...(allocationSides && { allocationReason }),
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

export function SwapRequests({
  state,
  action,
}: {
  state: AppState;
  action: Action;
}) {
  const soldierId = state.actor.soldierId;
  const manager = state.actor.role === "manager";
  const all = swaps(state);
  const incoming = all.filter(
    (row) =>
      row.fromSoldierId !== soldierId &&
      rows(row.candidates).some((item) => item.soldierId === soldierId)
  );
  const outgoing = all.filter((row) => row.fromSoldierId === soldierId);
  return (
    <>
      <Panel
        title="הצעות החלפה שקיבלתי"
        subtitle="בהסכמה שני השיבוצים מתחלפים יחד, וכל אחד מקבל את מלוא הניקוד של התורנות החדשה שלו"
      >
        {incoming.length ? (
          incoming.map((row) => {
            const mine = rows(row.candidates).filter(
              (item) => item.soldierId === soldierId
            );
            const accepted = row.acceptedBy === soldierId;
            return (
              <article className="task-item" key={row.id}>
                <div className="grow">
                  <strong>
                    {str(row.dutyName)} — מאת{" "}
                    {personName(state, row.fromSoldierId)}
                  </strong>
                  <EntryLine state={state} entry={row} />
                  {mine.map((entry) => (
                    <div className="inline" key={str(entry.assignmentId)}>
                      <small>
                        במקום: {str(entry.dutyName)} · {num(entry.points)}{" "}
                        נקודות ·{" "}
                        {entryLabels[str(entry.status)] ?? str(entry.status)}
                      </small>
                      {row.status === "awaiting_consent" &&
                        entry.status === "pending" && (
                          <>
                            <ActionDialog
                              title="הסכמה להחלפה"
                              buttonLabel="הסכמה"
                              description={`התנאים של שני הצדדים ייבדקו שוב עכשיו. אם הכול תקין ושתי התורנויות טרם התחילו, תקבל/י את ${str(row.dutyName)} ו${personName(state, row.fromSoldierId)} יקבל את ${str(entry.dutyName)}.`}
                              fields={[
                                {
                                  name: "confirmed",
                                  label: "אני מסכים להחלפה",
                                  type: "checkbox",
                                  required: true,
                                },
                              ]}
                              action={action}
                              type="swap.respond"
                              payload={{
                                id: row.id,
                                assignmentId: entry.assignmentId,
                                decision: "accept",
                              }}
                              version={num(row.version)}
                            />
                            <QuickAction
                              action={action}
                              type="swap.respond"
                              payload={{
                                id: row.id,
                                assignmentId: entry.assignmentId,
                                decision: "decline",
                              }}
                              version={num(row.version)}
                            >
                              דחייה
                            </QuickAction>
                          </>
                        )}
                    </div>
                  ))}
                  {accepted && <Reasons row={row} />}
                  {accepted && <Outcome row={row} />}
                </div>
                <div className="inline">
                  <Status value={row.status} />
                  {row.status === "awaiting_manager" && accepted && (
                    <Retract
                      action={action}
                      row={row}
                      label="ביטול ההסכמה"
                      description="ההחלפה תיסגר לפני החלטת האחראי, ושני השיבוצים יישארו כפי שהיו."
                    />
                  )}
                </div>
              </article>
            );
          })
        ) : (
          <Empty title="אין הצעות החלפה שהתקבלו" />
        )}
      </Panel>
      <Panel title="הצעות החלפה ששלחתי" subtitle="אפשר להציע החלפה מדף התורנות">
        {outgoing.length ? (
          outgoing.map((row) => (
            <article className="task-item" key={row.id}>
              <div className="grow">
                <strong>{str(row.dutyName)}</strong>
                <EntryLine state={state} entry={row} />
                {row.mailLimited === true && (
                  <small>
                    ההצעה נשמרה באתר; חלק מהמיילים לא נשלחו בגלל המכסה היומית.
                  </small>
                )}
                <small>
                  {rows(row.candidates)
                    .map(
                      (item) =>
                        `${personName(state, item.soldierId)} (${str(item.dutyName)}): ${entryLabels[str(item.status)] ?? str(item.status)}`
                    )
                    .join(" · ")}
                </small>
                <Reasons row={row} />
                <Outcome row={row} />
              </div>
              <div className="inline">
                <Status value={row.status} />
                {row.status === "awaiting_manager" && (
                  <Retract
                    action={action}
                    row={row}
                    label="ביטול ההחלפה"
                    description="ההחלפה תיסגר לפני החלטת האחראי, ושני השיבוצים יישארו כפי שהיו."
                  />
                )}
                {row.status === "awaiting_consent" && (
                  <QuickAction
                    action={action}
                    type="swap.withdraw"
                    payload={{ id: row.id }}
                    version={num(row.version)}
                  >
                    ביטול ההצעה
                  </QuickAction>
                )}
              </div>
            </article>
          ))
        ) : (
          <Empty title="לא שלחת הצעות החלפה" />
        )}
      </Panel>
      {manager && (
        <Panel
          title="החלפות ביחידה"
          subtitle="החלפה תקינה לפני התחלת שתי התורנויות מושלמת בלי אישור אחראי. עד החלטה בהחלפה שממתינה לטיפול, השיבוצים המקוריים בתוקף"
        >
          {all.length ? (
            all.map((row) => {
              const accepted = rows(row.candidates).find(
                (item) => item.assignmentId === row.acceptedAssignmentId
              );
              return (
                <article className="task-item" key={row.id}>
                  <div className="grow">
                    <strong>
                      {personName(state, row.fromSoldierId)} (
                      {str(row.dutyName)})
                      {accepted
                        ? ` ⇄ ${personName(state, accepted.soldierId)} (${str(accepted.dutyName)})`
                        : ""}
                    </strong>
                    <small>
                      {rows(row.candidates)
                        .map(
                          (item) =>
                            `${personName(state, item.soldierId)} (${str(item.dutyName)}): ${entryLabels[str(item.status)] ?? str(item.status)}`
                        )
                        .join(" · ")}
                    </small>
                    {rows(row.managerReasons).map((reason, index) => (
                      <small key={index}>
                        {reason.soldierId
                          ? `${personName(state, reason.soldierId)}: `
                          : ""}
                        {str(reason.message)}
                      </small>
                    ))}
                    <Outcome row={row} />
                    {rows(row.approvals).length ? (
                      <small>
                        סיבת אישור החריגים: {str(rows(row.approvals)[0].reason)}
                      </small>
                    ) : null}
                  </div>
                  <div className="inline">
                    <Status value={row.status} />
                    {row.status === "awaiting_manager" && (
                      <SwapDecision state={state} action={action} row={row} />
                    )}
                  </div>
                </article>
              );
            })
          ) : (
            <Empty title="אין החלפות" />
          )}
        </Panel>
      )}
    </>
  );
}
