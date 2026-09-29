"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  type Action,
  type AppState,
  type Row,
  rows,
  str,
  num,
  personName,
  displayDate,
} from "@/client/types";
import { ActionDialog, Form, Notice, Panel, Empty } from "./ui";
import { callUpFields, callUpValue } from "./call-up";
export function LotteryButton({
  state,
  action,
  duty,
  slotId,
}: {
  state: AppState;
  action: Action;
  duty: Row;
  slotId: string;
}) {
  return (
    <ActionDialog
      title="הגרלת מועמד"
      action={action}
      type="duty.lottery"
      payload={{ dutyId: duty.id, slotId }}
      version={duty.version}
      description="הבחירה נשמרת ומוצגת בהסבר ההגרלה. מועמד שדורש אישור לא ישובץ עד להחלטה."
      transform={(values) => ({
        reviewPending: values.reviewPending,
        callUpBonus: callUpValue(values),
      })}
      fields={[
        ...callUpFields(duty, { label: "הזנקה למקום זה" }),
        ...(state.constraints.some((row) => row.pending)
          ? [
              {
                name: "reviewPending",
                label: "מאשר להמשיך לפני השלמת סקירת האילוצים הממתינים",
                type: "checkbox" as const,
                required: true,
              },
            ]
          : []),
      ]}
    />
  );
}
const labels: Record<string, string> = {
  assigned: "שובץ",
  approval_required: "ממתין לאישור",
  rejected: "נדחה",
  stale: "התיישן — נדרשת הגרלה חדשה",
  unfilled: "אין מועמדים מתאימים",
  manual_only: "שווי אפס — שיבוץ ידני",
  filled: "אויש בפעולה אחרת",
};
/** Why a seat stayed empty: the draw outcome and how many candidates each check excluded. */
function missingReason(state: AppState, run: Row, slotId: string) {
  const result = rows(run.results).find((row) => row.slotId === slotId);
  const attempt = rows(state.lotteryAttempts).find(
    (row) => row.id === result?.proposalId
  );
  if (!attempt) return "לא הוגרל בריצה זו";
  const counts = new Map<string, number>();
  for (const candidate of rows(attempt.candidates))
    if (candidate.status === "blocked")
      for (const blocker of rows(candidate.blockers))
        counts.set(
          str(blocker.message),
          (counts.get(str(blocker.message)) ?? 0) + 1
        );
  const reasons = [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([message, count]) => `${message} (${count})`)
    .join(" · ");
  const label = labels[str(attempt.status)] ?? str(attempt.status);
  return reasons ? `${label}: ${reasons}` : label;
}
function MissingSeats({ state, run }: { state: AppState; run: Row }) {
  const missing = rows(run.missing);
  if (!missing.length) return null;
  return (
    <details>
      <summary>מקומות לא מאוישים וסיבות הפסילה</summary>
      <ul>
        {missing.map((seat) => {
          const duty = state.duties.find((row) => row.id === seat.dutyId);
          const role = rows(duty?.slots).find(
            (slot) => slot.id === seat.slotId
          );
          return (
            <li key={str(seat.slotId)}>
              <Link className="text-link" href={`/duties/${str(seat.dutyId)}`}>
                {str(duty?.name)} · {displayDate(duty?.start)}
                {role ? ` · ${str(role.role ?? role.name)}` : ""}
              </Link>
              <p>{missingReason(state, run, str(seat.slotId))}</p>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
export function LotteryHistory({
  state,
  action,
  dutyId,
}: {
  state: AppState;
  action: Action;
  dutyId: string;
}) {
  const attempts = rows(state.lotteryAttempts).filter(
    (row) => row.dutyId === dutyId
  );
  return (
    <Panel title="הגרלות והחלטות">
      {attempts.length ? (
        attempts.map((row) => (
          <article className="subsection" key={row.id}>
            <h3>
              {labels[str(row.status)] ?? str(row.status)}
              {row.candidateId
                ? ` · ${personName(state, row.candidateId)}`
                : ""}
            </h3>
            <p>
              שווי המקום: {num(row.weight)} · מינימום בין המתאימים:{" "}
              {row.minimum === null ? "—" : num(row.minimum)} ·{" "}
              {Array.isArray(row.band) ? row.band.length : 0} מועמדים ברצועה
            </p>
            {row.status === "approval_required" && (
              <>
                <Notice>
                  האישור חל רק על המועמד והמקום האלה. השיבוץ ייבדק שוב מול המצב
                  העדכני.
                </Notice>
                <Form
                  fields={[
                    ...rows(row.requirements).map((requirement, index) => ({
                      name: `approval${index}`,
                      label: str(requirement.message),
                      type: "checkbox" as const,
                      required: true,
                    })),
                    {
                      name: "reason",
                      label: "סיבת אישור המועמד",
                      type: "textarea",
                      required: true,
                    },
                  ]}
                  submitLabel="אישור המועמד ושיבוץ"
                  onSubmit={(values) =>
                    action(
                      "duty.lottery.approve",
                      {
                        proposalId: row.id,
                        decision: "approve",
                        reason: values.reason,
                        approvalKeys: rows(row.requirements).map(
                          (item) => item.key
                        ),
                      },
                      row.version
                    )
                  }
                />
                <ActionDialog
                  title="דחיית המועמד והגרלה מחדש"
                  fields={[
                    {
                      name: "reason",
                      label: "סיבת דחיית המועמד",
                      required: true,
                    },
                  ]}
                  action={action}
                  type="duty.lottery.approve"
                  payload={{ proposalId: row.id, decision: "reject" }}
                  version={row.version}
                />
              </>
            )}
            <details>
              <summary>הסבר המועמדים והבחירה</summary>
              <p>
                הסיכוי שווה לכל מי שנכלל ברצועה: ניקוד לשיבוץ קטן מהמינימום ועוד
                שווי המקום.
              </p>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>חייל</th>
                      <th>ניקוד לשיבוץ</th>
                      <th>ברצועה</th>
                      <th>בדיקת התאמה</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows(row.candidates).map((candidate) => (
                      <tr key={candidate.id}>
                        <td>
                          {state.soldiers.some((s) => s.id === candidate.id)
                            ? personName(state, candidate.id)
                            : "קליטה שבוטלה"}
                        </td>
                        <td>{num(candidate.score)}</td>
                        <td>
                          {Array.isArray(row.band) &&
                          row.band.includes(candidate.id)
                            ? "כן"
                            : "לא"}
                        </td>
                        <td>
                          {[
                            ...rows(candidate.blockers),
                            ...rows(candidate.approvalsRequired),
                          ]
                            .map((item) => str(item.message))
                            .join("; ") || "מתאים"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {Array.isArray(row.excludedIds) && row.excludedIds.length > 0 && (
                <p>
                  נדחו למופע זה:{" "}
                  {row.excludedIds
                    .map((id) => personName(state, id))
                    .join(", ")}
                </p>
              )}
            </details>
          </article>
        ))
      ) : (
        <Empty title="טרם בוצעה הגרלה למופע" />
      )}
    </Panel>
  );
}
export function PeriodPlanning({
  state,
  action,
}: {
  state: AppState;
  action: Action;
}) {
  const [running, setRunning] = useState("");
  const stop = useRef(false);
  useEffect(
    () => () => {
      stop.current = true;
    },
    []
  );
  const continueRun = async (run: Row) => {
    setRunning(run.id);
    stop.current = false;
    let current = run;
    try {
      do {
        const result = await action(
          "planning.step",
          { id: current.id },
          current.version
        );
        current = {
          ...result,
          id: str(result.id),
          version: num(result.version),
        };
      } while (!stop.current && current.status === "running");
    } catch {
      /* Workspace displays the actionable error. Saved steps are retained. */
    } finally {
      setRunning("");
    }
  };
  return (
    <>
      <Panel title="מילוי חוסרים לתקופה">
        <Form
          fields={[
            { name: "start", label: "מתאריך", type: "date", required: true },
            { name: "end", label: "עד תאריך", type: "date", required: true },
            {
              name: "dutyIds",
              label: "מופעים לתכנון (ללא בחירה — כל הטיוטות בתקופה)",
              type: "multiselect",
              options: state.duties
                .filter((row) => row.status === "draft")
                .map((row) => ({
                  value: row.id,
                  label: `${str(row.name)} · ${displayDate(row.start)}`,
                })),
            },
            {
              name: "reviewPending",
              label:
                "מאשר להמשיך לפני סקירת האילוצים ולהחליט בנפרד על התנגשויות",
              type: "checkbox",
            },
          ]}
          submitLabel="יצירת ריצת תכנון"
          onSubmit={async (values) => {
            const result = await action("planning.run", {
              ...values,
              dutyIds:
                Array.isArray(values.dutyIds) && values.dutyIds.length
                  ? values.dutyIds
                  : undefined,
            });
            await continueRun({
              ...result,
              id: str(result.id),
              version: num(result.version),
            });
          }}
        />
        <Notice>
          תכנון התקופה כולל טיוטות שמתחילות בטווח. כל שיבוץ נשמר בנפרד. יציאה
          מהמסך מאפשרת להמשיך מהמקומות שכבר נשמרו.
        </Notice>
      </Panel>
      <Panel title="ריצות תכנון שמורות">
        {rows(state.planningRuns).length ? (
          rows(state.planningRuns).map((run) => (
            <div className="subsection" key={run.id}>
              <h3>
                {displayDate(run.start)} — {displayDate(run.end)}
              </h3>
              <p>
                {run.status === "completed"
                  ? `הסתיים · ${rows(run.missing).length} מקומות לא מאוישים`
                  : run.status === "awaiting_approval"
                    ? "ממתין להחלטת אחראי"
                    : "ניתן להמשיך"}{" "}
                ·{" "}
                {
                  rows(run.results).filter((row) => row.status === "assigned")
                    .length
                }{" "}
                בחירות נשמרו
              </p>
              {run.reviewConfirmedAt ? (
                <p>
                  אישור המשך לפני סקירה ניתן ב־
                  {displayDate(run.reviewConfirmedAt, true)} וחל על{" "}
                  {rows(run.reviewCovers).length} אילוצים שהמתינו אז. אילוץ
                  ממתין חדש יעצור את הריצה עד אישור חדש.
                </p>
              ) : null}
              <MissingSeats state={state} run={run} />
              {running === run.id ? (
                <button
                  className="btn secondary"
                  onClick={() => {
                    stop.current = true;
                  }}
                >
                  עצירה אחרי המקום הנוכחי
                </button>
              ) : (
                run.status !== "completed" && (
                  <button
                    className="btn primary"
                    disabled={Boolean(running)}
                    onClick={() => void continueRun(run)}
                  >
                    המשך תכנון
                  </button>
                )
              )}
              {run.status !== "completed" &&
                !running &&
                state.constraints.some((row) => row.pending) && (
                  <ActionDialog
                    title="אישור המשך לפני סקירת אילוצים"
                    fields={[
                      {
                        name: "reviewPending",
                        label: "מאשר להמשיך ולבדוק כל התנגשות בנפרד",
                        type: "checkbox",
                        required: true,
                      },
                    ]}
                    action={action}
                    type="planning.step"
                    payload={{ id: run.id }}
                    version={run.version}
                  />
                )}
              {rows(run.results).map((result, index) => (
                <p key={index}>
                  <Link
                    className="text-link"
                    href={`/duties/${str(result.dutyId)}`}
                  >
                    {str(
                      state.duties.find((duty) => duty.id === result.dutyId)
                        ?.name
                    )}{" "}
                    · {labels[str(result.status)] ?? str(result.status)}
                  </Link>
                </p>
              ))}
            </div>
          ))
        ) : (
          <Empty title="אין ריצות תכנון" />
        )}
      </Panel>
    </>
  );
}
