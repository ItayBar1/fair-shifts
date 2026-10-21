"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { type Action, num, rows, str } from "@/client/types";
import { type FairnessRow } from "@/client/fairness";

import { type Preview } from "./score-change";

export function EditingRow({
  action,
  soldier,
  columns,
  render,
  onClose,
}: {
  action: Action;
  soldier: FairnessRow;
  columns: number;
  /** The table row itself, given the cell that now holds the input. */
  render: (cell: ReactNode) => ReactNode;
  onClose: () => void;
}) {
  const before = num(soldier.currentScore);
  const [value, setValue] = useState(String(before));
  const [typed, setTyped] = useState(false);
  const [reason, setReason] = useState("");
  const [seen, setSeen] = useState(before);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const reasonRef = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.select(), []);
  useEffect(() => {
    if (typed) reasonRef.current?.focus();
  }, [typed]);
  const after = Number(value);
  const valid = value !== "" && Number.isInteger(after) && after >= 0;
  const name = str(soldier.name);
  async function confirm() {
    setPending(true);
    setError("");
    try {
      const command = {
        soldierIds: [soldier.id],
        operation: "set",
        value: after,
        reason: reason.trim(),
      };
      const preview = (await action("score.preview", command)) as Preview;
      const now = num(rows(preview.rows)[0]?.before);
      if (now !== seen) {
        // The balance changed since it was shown: confirm the new change.
        setSeen(now);
        setError(`היתרה השתנתה בינתיים ל־${now}. יש לאשר שוב.`);
        return;
      }
      await action("score.apply", { ...command, token: preview.token });
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "השינוי לא נשמר");
    } finally {
      setPending(false);
    }
  }
  const cell = (
    <input
      ref={input}
      className="cell-input"
      aria-label={`יתרה חדשה ל${name}`}
      type="number"
      dir="ltr"
      min={0}
      step={1}
      value={value}
      disabled={pending}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
        if (e.key === "Enter" && valid && after !== before) setTyped(true);
      }}
    />
  );
  return (
    <>
      {render(cell)}
      {typed && (
        <tr className="edit-row">
          <td colSpan={columns}>
            <form
              className="edit-line"
              aria-label={`אישור יתרה חדשה ל${name}`}
              onSubmit={(e) => {
                e.preventDefault();
                void confirm();
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") onClose();
              }}
            >
              <strong>
                {name}: {seen} ← {after}
              </strong>
              <input
                ref={reasonRef}
                aria-label="סיבת השינוי"
                placeholder="סיבת השינוי (חובה)"
                required
                value={reason}
                disabled={pending}
                onChange={(e) => setReason(e.target.value)}
              />
              <button
                className="btn primary"
                type="submit"
                disabled={pending || !reason.trim()}
                aria-busy={pending}
              >
                אישור
              </button>
              <button
                className="btn secondary"
                type="button"
                onClick={onClose}
                disabled={pending}
              >
                ביטול
              </button>
              {error && (
                <span className="edit-error" role="alert">
                  {error}
                </span>
              )}
            </form>
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * The ledger as a sortable table. The soldier and recording-time columns show
 * only in the unit's ledger; one soldier's drawer keeps to what fits it. A
 * soldier's own history has no reasons or audit links (decision 168).
 */
