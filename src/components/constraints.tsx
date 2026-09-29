"use client";
import { useState } from "react";
import {
  type AppState,
  type Action,
  type Row,
  str,
  rows,
  obj,
  displayDate,
  personName,
} from "@/client/types";
import {
  constraintDisplay,
  roundNoticeSummary,
  roundPhase,
} from "@/client/constraints";
import {
  Panel,
  Empty,
  Form,
  QuickAction,
  Status,
  Notice,
  ActionDialog,
  Modal,
  type Field,
} from "./ui";
type Props = { state: AppState; action: Action };
function rangeFields(
  value: Record<string, unknown> = {},
  suffix = "",
  number = ""
): Field[] {
  return [
    {
      name: `startDate${suffix}`,
      label: `מיום${number}`,
      type: "date",
      required: true,
      value: str(value.start),
    },
    {
      name: `endDate${suffix}`,
      label: `עד יום (כולל)${number}`,
      type: "date",
      required: true,
      value: str(value.end),
    },
    {
      name: `reason${suffix}`,
      label: `סיבת האילוץ${number}`,
      type: "textarea",
      required: true,
      full: true,
      value: str(value.reason),
    },
  ];
}
function ConstraintForm({
  action,
  roundId,
  existing,
}: {
  action: Action;
  roundId: string;
  existing: Row[];
}) {
  const [count, setCount] = useState(1);
  const [none, setNone] = useState(false);
  const active = existing.filter((row) => constraintDisplay(row).cancellable);
  const fields = none
    ? []
    : Array.from({ length: count }, (_, i) =>
        rangeFields({}, i ? String(i) : "", i ? ` ${i + 1}` : "")
      ).flat();
  return (
    <>
      {existing.length > 0 && (
        <p className="muted">
          ההגשה שלך לסבב זה נרשמה. אפשר לעדכן אותה כל עוד החלון פתוח.
        </p>
      )}
      <label className="field check-field">
        <input
          type="checkbox"
          checked={none}
          onChange={(event) => setNone(event.target.checked)}
        />
        <span>אין לי אילוצים</span>
      </label>
      <Form
        fields={fields}
        onSubmit={(values) =>
          action(
            "constraint.submit",
            none
              ? {
                  roundId,
                  none: true,
                  existingVersions: existing.map((row) => ({
                    id: row.id,
                    version: row.version,
                  })),
                }
              : {
                  roundId,
                  items: Array.from({ length: count }, (_, i) => {
                    const suffix = i ? String(i) : "";
                    return {
                      startDate: values[`startDate${suffix}`],
                      endDate: values[`endDate${suffix}`],
                      reason: values[`reason${suffix}`],
                    };
                  }),
                }
          )
        }
        submitLabel="שליחת הגשה"
      >
        {!none && (
          <div className="form-actions">
            <button
              className="btn secondary"
              type="button"
              disabled={count >= 100}
              onClick={() => setCount((value) => value + 1)}
            >
              הוספת טווח נוסף
            </button>
            {count > 1 && (
              <button
                className="btn secondary"
                type="button"
                onClick={() => setCount((value) => value - 1)}
              >
                הסרת הטווח האחרון
              </button>
            )}
          </div>
        )}
        {none &&
          (active.length > 0 ? (
            <Notice>
              ההצהרה תבקש לבטל את האילוצים הקיימים בסבב. אילוץ מאושר נשאר בתוקף
              עד שהאחראי מאשר את ביטולו.
            </Notice>
          ) : (
            <Notice>
              ההצהרה נרשמת מיד כהשלמת ההגשה לסבב, בלי צורך באישור אחראי.
            </Notice>
          ))}
      </Form>
    </>
  );
}
function ApproveConstraint({ row, action }: { row: Row; action: Action }) {
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(false);
  return (
    <>
      <button
        className="btn secondary"
        disabled={loading}
        onClick={async () => {
          setLoading(true);
          try {
            setPreview(
              await action("constraint.preview", { id: row.id }, row.version)
            );
          } catch {
            /* Workspace displays the error. */
          } finally {
            setLoading(false);
          }
        }}
      >
        אישור
      </button>
      {preview && (
        <Modal title="בדיקת השפעת האישור" onClose={() => setPreview(null)}>
          {rows(preview.conflicts).length ? (
            <>
              <Notice>
                האישור מתנגש בשיבוצים הבאים. הם יישארו בלוח ויסומנו לטיפול
                ולהחלפה.
              </Notice>
              {rows(preview.conflicts).map((duty) => (
                <p key={duty.id}>
                  <strong>{str(duty.name)}</strong> ·{" "}
                  {displayDate(duty.start, true)} —{" "}
                  {displayDate(duty.end, true)}
                </p>
              ))}
            </>
          ) : (
            <p>לא נמצאו שיבוצים המתנגשים בגרסה הממתינה.</p>
          )}
          <Form
            fields={[
              {
                name: "confirmed",
                label: "בדקתי את השפעת האישור",
                type: "checkbox",
                required: true,
              },
            ]}
            submitLabel="אישור האילוץ"
            onSubmit={async () => {
              await action(
                "constraint.review",
                {
                  id: row.id,
                  decision: "approved",
                  impactToken: preview.impactToken,
                },
                row.version
              );
              setPreview(null);
            }}
          />
        </Modal>
      )}
    </>
  );
}
export function ConstraintsView({
  state,
  manage,
  action,
}: Props & { manage: boolean }) {
  const [roundId, setRoundId] = useState("");
  // Fixed per visit; the server remains the authority on the window.
  const [now] = useState(() => Date.now());
  const own = state.constraints.filter(
    (row) =>
      row.roundId === roundId &&
      (!manage || row.subjectId === state.actor.soldierId)
  );
  return (
    <>
      <Panel
        title="סבבי אילוצים"
        actions={
          manage && (
            <ActionDialog
              title="פתיחת סבב"
              action={action}
              type="round.create"
              fields={[
                { name: "name", label: "שם הסבב", required: true },
                {
                  name: "opensAt",
                  label: "פתיחת הגשות",
                  type: "datetime-local",
                  required: true,
                },
                {
                  name: "closesAt",
                  label: "סגירת הגשות",
                  type: "datetime-local",
                  required: true,
                },
                {
                  name: "targetStart",
                  label: "תחילת תקופת יעד",
                  type: "date",
                  required: true,
                },
                {
                  name: "targetEnd",
                  label: "סיום תקופת יעד",
                  type: "date",
                  required: true,
                },
              ]}
            />
          )
        }
      >
        {state.rounds.length ? (
          state.rounds.map((round) => {
            const phase = roundPhase(round, now);
            const submitted = state.constraints.filter(
              (row) => row.roundId === round.id
            );
            const submitters = new Set(submitted.map((row) => row.subjectId));
            const declared = submitted.filter(
              (row) => row.status === "declared"
            ).length;
            return (
              <div className="task-item" key={round.id}>
                <div className="grow">
                  <h3>{str(round.name)}</h3>
                  <p>
                    תקופת יעד: {displayDate(round.targetStart)} —{" "}
                    {displayDate(round.targetEnd)}
                  </p>
                  <small>
                    {phase === "upcoming"
                      ? `ההגשה נפתחת ב־${displayDate(round.opensAt, true)} ונסגרת ב־${displayDate(round.closesAt, true)}`
                      : round.status === "closed"
                        ? `ההגשה נסגרה ב־${displayDate(round.closedAt, true)}${manage && round.closedByName ? ` בידי ${str(round.closedByName)}` : ""}`
                        : `הגשה עד ${displayDate(round.closesAt, true)}`}
                  </small>
                  {round.reopenedAt ? (
                    <p>
                      נפתח מחדש ב־{displayDate(round.reopenedAt, true)}
                      {manage && round.reopenedByName
                        ? ` בידי ${str(round.reopenedByName)}`
                        : ""}
                    </p>
                  ) : null}
                  {manage && (
                    <p>
                      הגישו: {submitters.size}
                      {declared ? ` · מתוכם ״אין לי אילוצים״: ${declared}` : ""}
                    </p>
                  )}
                  {manage &&
                    roundNoticeSummary(
                      round,
                      rows(state.roundNotices),
                      now
                    ).map((line) => <small key={line}>{line}</small>)}
                </div>
                <Status value={phase} />
                {manage && (
                  <>
                    {round.status !== "closed" && (
                      <QuickAction
                        action={action}
                        type="round.close"
                        payload={{ id: round.id }}
                        version={round.version}
                      >
                        סגירת הגשות
                      </QuickAction>
                    )}
                    <ActionDialog
                      title={phase === "closed" ? "פתיחה מחדש" : "הארכת ההגשה"}
                      action={action}
                      type="round.reopen"
                      payload={{ id: round.id }}
                      version={round.version}
                      fields={[
                        {
                          name: "closesAt",
                          label: "מועד סגירה חדש",
                          type: "datetime-local",
                          required: true,
                        },
                      ]}
                    />
                  </>
                )}
              </div>
            );
          })
        ) : (
          <Empty title="אין סבבים" />
        )}
      </Panel>
      <Panel title="הגשת האילוצים שלי">
        <label className="field">
          <span>בחירת סבב</span>
          <select
            value={roundId}
            onChange={(event) => setRoundId(event.target.value)}
          >
            <option value="">בחירה…</option>
            {state.rounds
              .filter((round) => roundPhase(round, now) === "open")
              .map((round) => (
                <option value={round.id} key={round.id}>
                  {str(round.name)}
                </option>
              ))}
          </select>
        </label>
        {roundId && (
          <ConstraintForm
            key={roundId}
            action={action}
            roundId={roundId}
            existing={own}
          />
        )}
        <Notice>
          יש לפרט סיבה לכל טווח. אילוץ ללא סיבה מוצדקת עשוי להידחות בידי האחראי.
          שינוי ממתין אינו מבטל גרסה שאושרה.
        </Notice>
      </Panel>
      <Panel title={manage ? "הגשות לטיפול" : "ההגשות שלי"}>
        {state.constraints.length ? (
          state.constraints.map((row) => {
            const approved = obj(row.approved);
            const pending = obj(row.pending);
            const value = row.pending ? pending : approved;
            const display = constraintDisplay(row);
            const round = state.rounds.find((item) => item.id === row.roundId);
            const mine =
              (!manage || row.subjectId === state.actor.soldierId) &&
              Boolean(round && roundPhase(round, now) === "open");
            return (
              <article className="task-item" key={row.id}>
                <div className="grow">
                  <h3>
                    {manage
                      ? personName(state, row.subjectId)
                      : str(
                          state.rounds.find((round) => round.id === row.roundId)
                            ?.name
                        )}
                  </h3>
                  <Status value={display.status} />
                  {display.declared && (
                    <p>הוגש: אין לי אילוצים. נרשם ללא צורך באישור אחראי.</p>
                  )}
                  {row.approved ? (
                    <p>
                      מאושר:{" "}
                      {approved.none
                        ? "אין אילוצים"
                        : `${displayDate(approved.start)} — ${displayDate(approved.end)} · ${str(approved.reason)}`}
                    </p>
                  ) : null}
                  {row.pending && display.approvedInEffect ? (
                    <p>
                      שינוי ממתין לאישור. עד ההחלטה הגרסה המאושרת נשארת בתוקף.
                    </p>
                  ) : null}
                  {row.pending ? (
                    <p>
                      ממתין:{" "}
                      {pending.none
                        ? "אין אילוצים / ביטול הפריט"
                        : `${displayDate(pending.start)} — ${displayDate(pending.end)} · ${str(pending.reason)}`}
                    </p>
                  ) : null}
                  {display.changeRejected && (
                    <p>השינוי האחרון נדחה. הגרסה המאושרת נשארת בתוקף.</p>
                  )}
                  {row.status === "rejected" && row.rejected ? (
                    <p>
                      נדחה:{" "}
                      {obj(row.rejected).none
                        ? "ביטול הפריט"
                        : `${displayDate(obj(row.rejected).start)} — ${displayDate(obj(row.rejected).end)} · ${str(obj(row.rejected).reason)}`}
                    </p>
                  ) : null}
                  {row.status === "rejected" && (
                    <p>סיבת הדחייה: {str(row.decisionReason)}</p>
                  )}
                  {manage && row.decidedAt ? (
                    <small>
                      הוחלט בידי {str(row.decidedByName, "אחראי")} ·{" "}
                      {displayDate(row.decidedAt, true)}
                    </small>
                  ) : null}
                </div>
                {manage && row.pending ? (
                  <>
                    <ApproveConstraint row={row} action={action} />
                    <ActionDialog
                      title="דחיית השינוי"
                      fields={[
                        {
                          name: "reason",
                          label: "סיבת ההחלטה",
                          required: true,
                        },
                      ]}
                      action={action}
                      type="constraint.review"
                      payload={{ id: row.id, decision: "rejected" }}
                      version={row.version}
                    />
                  </>
                ) : null}
                {mine && (
                  <>
                    <ActionDialog
                      title="עריכת האילוץ"
                      fields={rangeFields(value)}
                      action={action}
                      type="constraint.submit"
                      payload={{ id: row.id, roundId: row.roundId }}
                      version={row.version}
                    />
                    {display.cancellable && !value.none && (
                      <ActionDialog
                        title="בקשת ביטול האילוץ"
                        description="אילוץ מאושר נשאר בתוקף עד לאישור ביטולו."
                        fields={[
                          {
                            name: "confirmed",
                            label: "ברצוני לבטל פריט זה",
                            type: "checkbox",
                            required: true,
                          },
                        ]}
                        action={action}
                        type="constraint.submit"
                        payload={{
                          id: row.id,
                          roundId: row.roundId,
                          none: true,
                        }}
                        version={row.version}
                      />
                    )}
                  </>
                )}
              </article>
            );
          })
        ) : (
          <Empty title="עדיין אין הגשות" />
        )}
      </Panel>
    </>
  );
}
