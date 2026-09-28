"use client";
import { useState } from "react";
import { DateTime } from "luxon";
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
import { Badge, Empty, Form, Modal, Notice, Panel, type Field } from "./ui";

const local = (value: unknown) =>
  DateTime.fromISO(str(value))
    .setZone("Asia/Jerusalem")
    .toFormat("yyyy-MM-dd'T'HH:mm");

/** Recorded performance of a credited assignment, falling back to the published schedule. */
export function performanceOf(assignment: Row, duty: Row) {
  const performance = obj(assignment.performance);
  return {
    performerId: str(performance.performerId, str(assignment.soldierId)),
    start: str(
      performance.start,
      str(assignment.performedStart, str(duty.start))
    ),
    end: str(performance.end, str(assignment.performedEnd, str(duty.end))),
    points: num(performance.points, num(assignment.points)),
    corrected: Boolean(assignment.performance),
  };
}

export function PerformanceCorrections({
  state,
  action,
  duty,
}: {
  state: AppState;
  action: Action;
  duty: Row;
}) {
  const credited = state.assignments.filter(
    (row) => row.dutyId === duty.id && row.status === "credited"
  );
  const corrections = rows(state.performanceCorrections).filter(
    (row) => row.dutyId === duty.id
  );
  const decisions = rows(state.scoreDecisions).filter(
    (row) => row.dutyId === duty.id && row.status === "pending"
  );
  return (
    <Panel
      title="תיקון ביצוע עבר"
      subtitle="תיקון מועדים, מבצע או שווי של תורנות שהסתיימה. השווי ששימש בהגרלה נשמר כפי שהיה."
    >
      {decisions.map((row) => (
        <Notice tone="warning" key={row.id}>
          ההיסטוריה של {personName(state, row.soldierId)} תוקנה ל־
          {num(row.historyPoints)} נקודות, והיתרה כיום משקפת{" "}
          {num(row.reflectedPoints)}. ההשפעה על היתרה ממתינה להכרעת אחראי.
        </Notice>
      ))}
      {credited.length ? (
        credited.map((assignment) => {
          const performance = performanceOf(assignment, duty);
          return (
            <div className="slot-row" key={assignment.id}>
              <span className="grow">
                <strong>{personName(state, performance.performerId)}</strong>
                <small>
                  {displayDate(performance.start, true)} —{" "}
                  {displayDate(performance.end, true)} · ביצוע{" "}
                  {performance.points} נקודות · בהגרלה {num(assignment.points)}{" "}
                  נקודות
                </small>
              </span>
              {performance.corrected && <Badge tone="info">תוקן</Badge>}
              <CorrectionDialog
                state={state}
                action={action}
                duty={duty}
                assignment={assignment}
              />
            </div>
          );
        })
      ) : (
        <Empty title="אין ביצוע שנזקף לתיקון" />
      )}
      {corrections.length > 0 && (
        <div className="table-scroll">
          <table>
            <caption>היסטוריית תיקונים</caption>
            <thead>
              <tr>
                <th>נרשם</th>
                <th>מבצע</th>
                <th>לפני</th>
                <th>אחרי</th>
                <th>סיבה</th>
              </tr>
            </thead>
            <tbody>
              {corrections.map((row) => {
                const before = obj(row.before);
                const after = obj(row.after);
                return (
                  <tr key={row.id}>
                    <td>{displayDate(row.recordedAt, true)}</td>
                    <td>{str(row.actorName)}</td>
                    <td>
                      {personName(state, before.performerId)} ·{" "}
                      {num(before.points)}
                    </td>
                    <td>
                      {personName(state, after.performerId)} ·{" "}
                      {num(after.points)}
                    </td>
                    <td>{str(row.reason)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function CorrectionDialog({
  state,
  action,
  duty,
  assignment,
}: {
  state: AppState;
  action: Action;
  duty: Row;
  assignment: Row;
}) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);
  const [input, setInput] = useState<Record<string, unknown>>({});
  const performance = performanceOf(assignment, duty);
  const close = () => {
    setOpen(false);
    setPreview(null);
  };
  const fields: Field[] = [
    {
      name: "performerId",
      label: "מי ביצע בפועל",
      type: "select",
      required: true,
      value: performance.performerId,
      options: state.soldiers
        .filter((row) => !row.deletedAt)
        .map((row) => ({ value: row.id, label: str(row.name) })),
    },
    {
      name: "start",
      label: "תחילת הביצוע",
      type: "datetime-local",
      required: true,
      value: local(performance.start),
    },
    {
      name: "end",
      label: "סיום הביצוע",
      type: "datetime-local",
      required: true,
      value: local(performance.end),
    },
    {
      name: "points",
      label: "שווי ידני",
      type: "number",
      min: 0,
      step: "1",
      hint: "להשאיר ריק לחישוב לפי המחירון של התורנות",
    },
    {
      name: "reason",
      label: "סיבת התיקון",
      type: "textarea",
      required: true,
      full: true,
    },
  ];
  const effects = rows(preview?.effects);
  const current = obj(preview?.current);
  const proposed = obj(preview?.proposed);
  return (
    <>
      <button className="btn secondary" onClick={() => setOpen(true)}>
        תיקון ביצוע
      </button>
      {open && (
        <Modal title="תיקון ביצוע עבר" onClose={close}>
          {!preview ? (
            <Form
              fields={fields}
              submitLabel="תצוגת השפעה"
              onSubmit={async (values) => {
                const payload = {
                  assignmentId: assignment.id,
                  performerId: values.performerId,
                  // Unedited fields keep the exact recorded instant rather than minute precision.
                  start:
                    values.start === local(performance.start)
                      ? performance.start
                      : values.start,
                  end:
                    values.end === local(performance.end)
                      ? performance.end
                      : values.end,
                  reason: values.reason,
                  ...(values.points !== "" && { points: values.points }),
                };
                const result = await action(
                  "performance.correction.preview",
                  payload,
                  assignment.version
                );
                setInput(payload);
                setPreview(result);
              }}
            />
          ) : (
            <>
              <div className="detail-grid">
                <div>
                  <small>שווי בהגרלה (נשמר)</small>
                  <strong>{num(preview.drawPoints)} נקודות</strong>
                </div>
                <div>
                  <small>ביצוע לפני התיקון</small>
                  <strong>
                    {personName(state, current.performerId)} ·{" "}
                    {num(current.points)} נקודות
                  </strong>
                </div>
                <div>
                  <small>ביצוע אחרי התיקון</small>
                  <strong>
                    {personName(state, proposed.performerId)} ·{" "}
                    {num(proposed.points)} נקודות
                  </strong>
                </div>
                <div>
                  <small>מועדים מתוקנים</small>
                  <strong>
                    {displayDate(proposed.start, true)} —{" "}
                    {displayDate(proposed.end, true)}
                  </strong>
                </div>
              </div>
              <p className="muted">
                {preview.manual
                  ? `שווי ידני. לפי המחירון: ${num(preview.computedPoints)} נקודות.`
                  : `חושב לפי המחירון: בסיס ${str(obj(preview.price).base)}, תוספת אישית ${str(obj(preview.price).extras)}.`}
              </p>
              {rows(preview.findings).length > 0 && (
                <Notice tone="warning">
                  ממצאי התאמה למבצע החדש (אינם חוסמים תיקון היסטורי):{" "}
                  {rows(preview.findings)
                    .map((row) => str(row.message))
                    .join(" · ")}
                </Notice>
              )}
              {effects.map((effect) => (
                <div className="result-box" key={str(effect.soldierId)}>
                  <strong>{str(effect.name)}</strong>
                  <p>
                    היסטוריה: {num(effect.historyBefore)} ←{" "}
                    {num(effect.historyAfter)} נקודות
                  </p>
                  {effect.status === "automatic" ? (
                    <p>
                      יתרה כיום: {num(effect.balance)} ← {num(effect.after)}
                      {effect.clamped ? " (נעצר ברצפת אפס)" : ""}
                    </p>
                  ) : (
                    <Notice tone="warning">
                      היתרה ({num(effect.balance)}) לא תשתנה אוטומטית.{" "}
                      {effect.decisionId
                        ? "קיימת כבר הכרעה פתוחה לביצוע הזה."
                        : `מאז הביצוע: ${rows(effect.barriers)
                            .map(
                              (row) =>
                                `${str(row.reason)} (${displayDate(row.effectiveAt, true)})`
                            )
                            .join(" · ")}.`}{" "}
                      תיווצר החלטה ממתינה ותזכורת לאחראים.
                    </Notice>
                  )}
                </div>
              ))}
              <Form
                fields={[
                  {
                    name: "confirmed",
                    label: "בדקתי את התיקון ואת השפעתו",
                    type: "checkbox",
                    required: true,
                  },
                ]}
                submitLabel="שמירת התיקון"
                onSubmit={async () => {
                  await action(
                    "performance.correction.apply",
                    { ...input, token: preview.token },
                    assignment.version
                  );
                  close();
                }}
              />
              <button
                className="btn secondary"
                onClick={() => setPreview(null)}
              >
                חזרה לעריכה
              </button>
            </>
          )}
        </Modal>
      )}
    </>
  );
}
