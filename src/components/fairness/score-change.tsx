"use client";
import { useState } from "react";
import {
  type Action,
  type AppState,
  type Row,
  num,
  personName,
  rows,
  str,
} from "@/client/types";
import { Notice } from "../ui";

export type Preview = { rows: Row[]; token: string };
export type ScoreInput = {
  soldierIds: string[];
  operation: string;
  value: number;
  reason: string;
};

export const operations = [
  { value: "add", label: "הוספת נקודות" },
  { value: "subtract", label: "הפחתת נקודות" },
  { value: "set", label: "קביעת יתרה" },
  { value: "percent", label: "הפחתת אחוזים" },
];

/**
 * A balance change for one soldier or several. Every change is first shown
 * before and after, then confirmed; it is written as a new ledger entry and
 * never edits one (the ledger is the balance's history).
 */
export function ScoreChange({
  state,
  action,
  soldierIds,
  onDone,
}: {
  state: AppState;
  action: Action;
  soldierIds: string[];
  onDone: () => void;
}) {
  const [operation, setOperation] = useState("add");
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [input, setInput] = useState<ScoreInput | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const run = async (step: () => Promise<void>) => {
    setPending(true);
    setError("");
    try {
      await step();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "הפעולה לא הושלמה");
    } finally {
      setPending(false);
    }
  };
  // Any change to the form makes the shown preview stale.
  const edit =
    <T,>(set: (next: T) => void) =>
    (next: T) => {
      set(next);
      setPreview(null);
    };
  return (
    <form
      className="score-change"
      onSubmit={(event) => {
        event.preventDefault();
        void run(async () => {
          const command = {
            soldierIds,
            operation,
            value: Number(value),
            reason: reason.trim(),
          };
          const result = (await action("score.preview", command)) as Preview;
          setInput(command);
          setPreview(result);
        });
      }}
    >
      <fieldset disabled={pending}>
        <div className="form-grid">
          <label className="field">
            <span>
              פעולה<span className="required"> *</span>
            </span>
            <select
              aria-label="פעולה"
              value={operation}
              onChange={(e) => edit(setOperation)(e.target.value)}
            >
              {operations.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>
              {operation === "percent" ? "אחוז" : "ערך"}
              <span className="required"> *</span>
            </span>
            <input
              aria-label="ערך"
              type="number"
              dir="ltr"
              min={0}
              max={operation === "percent" ? 100 : undefined}
              required
              value={value}
              onChange={(e) => edit(setValue)(e.target.value)}
            />
          </label>
          <label className="field full">
            <span>
              סיבה<span className="required"> *</span>
            </span>
            <textarea
              aria-label="סיבה"
              rows={2}
              required
              value={reason}
              onChange={(e) => edit(setReason)(e.target.value)}
            />
          </label>
        </div>
        {error && <Notice tone="danger">{error}</Notice>}
        {preview ? (
          <div className="result-box" role="status">
            {rows(preview.rows).map((row) => (
              <p key={str(row.soldierId)}>
                {personName(state, row.soldierId)}: {num(row.before)} ←{" "}
                {num(row.after)}
              </p>
            ))}
            <div className="form-actions">
              <button
                type="button"
                className="btn primary"
                onClick={() =>
                  void run(async () => {
                    await action("score.apply", {
                      ...input,
                      token: preview.token,
                    });
                    onDone();
                  })
                }
              >
                אישור שינוי היתרה
              </button>
              <button
                type="button"
                className="btn secondary"
                onClick={() => setPreview(null)}
              >
                חזרה לעריכה
              </button>
            </div>
          </div>
        ) : (
          <div className="form-actions">
            <button className="btn primary" type="submit" aria-busy={pending}>
              תצוגה מקדימה
            </button>
          </div>
        )}
      </fieldset>
    </form>
  );
}

/**
 * The balance typed straight into its cell: the new number opens a line under
 * the row with the change and a reason, and only its confirmation saves it,
 * as a "set balance" entry. If the balance moved meanwhile, the line shows the
 * new change and asks again.
 */
