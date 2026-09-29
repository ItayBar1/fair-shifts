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
import { Badge, Empty, Form, Modal, Panel, type Field } from "./ui";
import { performanceOf } from "./performance-corrections";

const choiceLabels: Record<string, string> = {
  keep: "לא לשנות את היתרה",
  adjust: "הוספה או הפחתה",
  set: "קביעת יתרה חדשה",
};

/** Intervening operations in effective order; the recording time is shown when it differs. */
function Barriers({ items }: { items: Row[] }) {
  if (!items.length)
    return (
      <p className="muted">
        אין פעולה מתערבת. ההחלטה נפתחה כי כבר הייתה הכרעה פתוחה לביצוע הזה.
      </p>
    );
  return (
    <ul className="plain-list">
      {items.map((item) => {
        const late =
          Math.abs(
            new Date(str(item.recordedAt)).getTime() -
              new Date(str(item.effectiveAt)).getTime()
          ) >= 60_000;
        return (
          <li key={str(item.id)}>
            <strong>{str(item.label)}</strong> · בתוקף מ־
            {displayDate(item.effectiveAt, true)}
            {late ? ` · נרשם ${displayDate(item.recordedAt, true)}` : ""} ·{" "}
            {num(item.before)} ← {num(item.after)}
            {str(item.reason) ? ` · ${str(item.reason)}` : ""}
          </li>
        );
      })}
    </ul>
  );
}

function PerformanceSummary({
  state,
  decision,
}: {
  state: AppState;
  decision: Row;
}) {
  const assignment = state.assignments.find(
    (row) => row.id === decision.assignmentId
  );
  const duty = state.duties.find((row) => row.id === decision.dutyId);
  const performance =
    assignment && duty ? performanceOf(assignment, duty) : undefined;
  const person = state.soldiers.find((row) => row.id === decision.soldierId);
  const history = num(decision.historyPoints);
  const reflected = num(decision.reflectedPoints);
  return (
    <div className="detail-grid">
      <div>
        <small>ביצוע מתוקן</small>
        <strong>
          {performance
            ? `${personName(state, performance.performerId)} · ${displayDate(performance.start, true)} — ${displayDate(performance.end, true)}`
            : "—"}
        </strong>
      </div>
      <div>
        <small>בהיסטוריה של החייל</small>
        <strong>
          {history} נקודות (היתרה משקפת {reflected})
        </strong>
      </div>
      <div>
        <small>הפרש בהיסטוריה (מידע בלבד)</small>
        <strong>
          {history - reflected > 0 ? "+" : ""}
          {history - reflected}
        </strong>
      </div>
      <div>
        <small>יתרה כיום</small>
        <strong>{num(person?.currentScore)}</strong>
      </div>
    </div>
  );
}

/** Pending balance decisions after a past correction, optionally limited to one duty, and the ones already closed there. */
export function ScoreDecisions({
  state,
  action,
  dutyId,
}: {
  state: AppState;
  action: Action;
  dutyId?: string;
}) {
  const all = rows(state.scoreDecisions).filter(
    (row) => !dutyId || row.dutyId === dutyId
  );
  const pending = all.filter((row) => row.status === "pending");
  const decided = all.filter((row) => row.status === "decided");
  if (!all.length && dutyId) return null;
  return (
    <Panel
      title="תיקוני יתרה ממתינים להכרעה"
      subtitle="ההיסטוריה כבר תוקנה. כאן מחליטים אם ובכמה לשנות את היתרה כיום."
    >
      {pending.length ? (
        pending.map((decision) => (
          <div
            className="result-box"
            key={decision.id}
            data-testid="score-decision"
          >
            <div className="slot-row">
              <span className="grow">
                <strong>{personName(state, decision.soldierId)}</strong>
                <small>
                  {dutyId ? (
                    "תורנות זו"
                  ) : (
                    <Link href={`/duties/${str(decision.dutyId)}`}>
                      {str(
                        state.duties.find((row) => row.id === decision.dutyId)
                          ?.name,
                        "התורנות"
                      )}
                    </Link>
                  )}{" "}
                  · {rows(decision.correctionIds).length} תיקונים · סיבה אחרונה:{" "}
                  {str(decision.reason)}
                </small>
              </span>
              <Badge tone="warning">ממתין להכרעה</Badge>
              <DecisionDialog
                state={state}
                action={action}
                decision={decision}
              />
            </div>
            <PerformanceSummary state={state} decision={decision} />
            <small>פעולות מתערבות מאז הביצוע</small>
            <Barriers items={rows(decision.barriers)} />
          </div>
        ))
      ) : (
        <Empty title="אין תיקוני יתרה שממתינים להכרעה" />
      )}
      {decided.length > 0 && (
        <div className="table-scroll">
          <table>
            <caption>הכרעות שנסגרו</caption>
            <thead>
              <tr>
                <th>הוכרע</th>
                <th>חייל</th>
                <th>אחראי</th>
                <th>הכרעה</th>
                <th>יתרה</th>
                <th>סיבה</th>
              </tr>
            </thead>
            <tbody>
              {decided.map((row) => {
                const resolution = obj(row.resolution);
                return (
                  <tr key={row.id}>
                    <td>{displayDate(row.decidedAt, true)}</td>
                    <td>{personName(state, row.soldierId)}</td>
                    <td>{str(row.decidedByName)}</td>
                    <td>
                      {choiceLabels[str(resolution.choice)]}
                      {resolution.choice === "adjust"
                        ? ` (${num(resolution.value) > 0 ? "+" : ""}${num(resolution.value)})`
                        : ""}
                    </td>
                    <td>
                      {num(resolution.balanceBefore)} ←{" "}
                      {num(resolution.balanceAfter)}
                    </td>
                    <td>{str(resolution.reason)}</td>
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

function DecisionDialog({
  state,
  action,
  decision,
}: {
  state: AppState;
  action: Action;
  decision: Row;
}) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);
  const [input, setInput] = useState<Record<string, unknown>>({});
  const close = () => {
    setOpen(false);
    setPreview(null);
  };
  const fields: Field[] = [
    {
      name: "choice",
      label: "ההכרעה",
      type: "select",
      required: true,
      value: str(input.choice, "keep"),
      options: Object.entries(choiceLabels).map(([value, label]) => ({
        value,
        label,
      })),
    },
    {
      name: "value",
      label: "נקודות",
      type: "number",
      step: "1",
      value: input.value === undefined ? "" : num(input.value),
      hint: "בהוספה או הפחתה: מספר שלם, שלילי להפחתה. בקביעה: היתרה החדשה. לא נדרש כשלא משנים.",
    },
    {
      name: "reason",
      label: "סיבת ההכרעה",
      type: "textarea",
      required: true,
      full: true,
      value: str(input.reason),
    },
  ];
  return (
    <>
      <button className="btn secondary" onClick={() => setOpen(true)}>
        הכרעה
      </button>
      {open && (
        <Modal
          title={`הכרעת ניקוד — ${personName(state, decision.soldierId)}`}
          onClose={close}
        >
          {!preview ? (
            <Form
              fields={fields}
              submitLabel="תצוגת השפעה"
              onSubmit={async (values) => {
                const payload = {
                  decisionId: decision.id,
                  choice: values.choice,
                  reason: values.reason,
                  ...(values.choice !== "keep" &&
                    values.value !== "" && { value: values.value }),
                };
                const result = await action(
                  "score.decision.preview",
                  payload,
                  decision.version
                );
                setInput(payload);
                setPreview(result);
              }}
            />
          ) : (
            <>
              <PerformanceSummary state={state} decision={decision} />
              <small>פעולות מתערבות מאז הביצוע</small>
              <Barriers items={rows(preview.barriers)} />
              <div className="result-box">
                <strong>{choiceLabels[str(preview.choice)]}</strong>
                <p>
                  יתרה כיום: {num(preview.balance)} ← {num(preview.after)}
                  {preview.clamped ? " (נעצר ברצפת אפס)" : ""}
                </p>
                <p className="muted">
                  ההיסטוריה, השווי ששימש בהגרלה ({num(preview.drawPoints)}{" "}
                  נקודות) ותמונת ההגרלה אינם משתנים. תיקון נוסף של הביצוע הזה
                  ייבדק מול ההיסטוריה שהוכרעה עכשיו.
                </p>
              </div>
              <Form
                fields={[
                  {
                    name: "confirmed",
                    label: "בדקתי את ההכרעה ואת השפעתה",
                    type: "checkbox",
                    required: true,
                  },
                ]}
                submitLabel="שמירת ההכרעה"
                onSubmit={async () => {
                  await action(
                    "score.decision.apply",
                    { ...input, token: preview.token },
                    decision.version
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
