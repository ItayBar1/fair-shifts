"use client";
import { useState, type FormEvent } from "react";
import { type Action, type AppState, rows, str, num } from "@/client/types";
import { importValue } from "@/client/import-values";
import { Badge, Notice } from "./ui";

export function ImportRestore({
  batch,
  state,
  action,
  onChange,
}: {
  batch: Record<string, unknown>;
  state: AppState;
  action: Action;
  onChange: (batch: Record<string, unknown>) => void;
}) {
  const [preview, setPreview] = useState<Record<string, unknown>>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [decisions, setDecisions] = useState<
    Record<string, { action: string; value?: string }>
  >({});
  async function prepare() {
    setBusy(true);
    setError("");
    setConfirmed(false);
    setDecisions({});
    try {
      setPreview(
        await action(
          "import.restore.preview",
          { id: batch.id },
          num(batch.version)
        )
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : "לא ניתן להכין שחזור");
    } finally {
      setBusy(false);
    }
  }
  async function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!preview) return;
    setBusy(true);
    setError("");
    const choices = rows(preview.rows).flatMap((row) =>
      rows(row.fields).flatMap((field) => {
        const choice = decisions[`${row.id}:${str(field.key)}`];
        return choice?.action
          ? [
              {
                rowId: row.id,
                key: field.key,
                action: choice.action,
                ...(choice.action === "set_score"
                  ? { value: Number(choice.value) }
                  : {}),
              },
            ]
          : [];
      })
    );
    try {
      onChange(
        await action(
          "import.restore",
          {
            id: batch.id,
            token: preview.token,
            reason,
            confirmed,
            decisions: choices,
          },
          num(preview.version)
        )
      );
      setPreview(undefined);
    } catch (error) {
      setError(error instanceof Error ? error.message : "השחזור לא הושלם");
    } finally {
      setBusy(false);
    }
  }
  if (!["applied", "partially_restored"].includes(str(batch.status)))
    return null;
  const planned = rows(preview?.rows);
  const fieldCount = planned.reduce(
    (sum, row) => sum + rows(row.fields).length,
    0
  );
  return (
    <div className="import-restore">
      <button
        type="button"
        className="btn secondary"
        disabled={busy}
        onClick={prepare}
      >
        בדיקת שחזור עדכונים
      </button>
      {error && <Notice tone="danger">{error}</Notice>}
      {preview && (
        <form onSubmit={apply} className="form-grid">
          <h3 className="full">בדיקת שחזור — לפי השינויים מאז הייבוא</h3>
          <div className="full">
            <Notice>
              שדות שלא השתנו ניתנים לשחזור. לכל התנגשות נדרשת הכרעה נפרדת.
              תורנויות ופעולות ניקוד מאוחרות נשמרות; השחזור מוסיף פעולה מתועדת.
            </Notice>
          </div>
          {planned.some((row) => row.pendingNew) && (
            <div className="full">
              <Notice>
                באצווה יש קליטות חדשות. שחזור קליטות חדשות עדיין אינו זמין;
                הפעולה הזו מטפלת בעדכונים לחיילים שהיו קיימים.
              </Notice>
            </div>
          )}
          {planned
            .filter((row) => rows(row.fields).length > 0)
            .map((row) => (
              <section className="full" key={row.id}>
                <h3>
                  {str(row.name)} · שורה {num(row.rowNumber)}
                </h3>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>שדה</th>
                        <th>לפני הייבוא</th>
                        <th>בייבוא</th>
                        <th>כעת</th>
                        <th>לאחר שחזור</th>
                        <th>החלטה</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows(row.fields).map((field) => {
                        const choiceKey = `${row.id}:${str(field.key)}`;
                        const choice = decisions[choiceKey];
                        const erased = field.status === "erased";
                        const conflict = field.status === "conflict";
                        return (
                          <tr key={str(field.key)}>
                            <td>
                              {str(field.label)}
                              <div>
                                <Badge
                                  tone={
                                    erased
                                      ? "danger"
                                      : conflict
                                        ? "warning"
                                        : "success"
                                  }
                                >
                                  {erased
                                    ? "מידע שנמחק"
                                    : conflict
                                      ? "השתנה מאז"
                                      : "ללא שינוי נוסף"}
                                </Badge>
                              </div>
                            </td>
                            <td>
                              {importValue(field.before, str(field.key), state)}
                            </td>
                            <td>
                              {importValue(field.after, str(field.key), state)}
                            </td>
                            <td>
                              {importValue(
                                field.current,
                                str(field.key),
                                state
                              )}
                            </td>
                            <td>
                              {erased
                                ? "לא יוחזר מידע"
                                : choice?.action === "keep"
                                  ? importValue(
                                      field.current,
                                      str(field.key),
                                      state
                                    )
                                  : choice?.action === "set_score"
                                    ? choice.value
                                    : importValue(
                                        field.proposed,
                                        str(field.key),
                                        state
                                      )}
                            </td>
                            <td>
                              {!erased && (
                                <>
                                  <label>
                                    <span className="sr-only">
                                      החלטה עבור {str(row.name)} —{" "}
                                      {str(field.label)}
                                    </span>
                                    <select
                                      aria-label={`החלטה עבור ${str(row.name)} — ${str(field.label)}`}
                                      value={
                                        choice?.action ??
                                        (conflict ? "" : "restore")
                                      }
                                      required
                                      disabled={busy}
                                      onChange={(event) =>
                                        setDecisions((current) => ({
                                          ...current,
                                          [choiceKey]: {
                                            action: event.target.value,
                                            value:
                                              field.source === "score"
                                                ? str(field.current)
                                                : undefined,
                                          },
                                        }))
                                      }
                                    >
                                      {conflict && (
                                        <option value="">יש לבחור החלטה</option>
                                      )}
                                      <option value="keep">
                                        להשאיר את הערך הנוכחי
                                      </option>
                                      {conflict && field.source === "score" ? (
                                        <option value="set_score">
                                          לקבוע יתרה במפורש
                                        </option>
                                      ) : (
                                        <option value="restore">
                                          לשחזר את שינוי הייבוא
                                        </option>
                                      )}
                                    </select>
                                  </label>
                                  {choice?.action === "set_score" && (
                                    <label className="field">
                                      <span>יתרה לאחר השחזור</span>
                                      <input
                                        aria-label={`יתרה לאחר השחזור עבור ${str(row.name)}`}
                                        type="number"
                                        min={0}
                                        max={2147483647}
                                        step="1"
                                        value={choice.value ?? ""}
                                        required
                                        disabled={busy}
                                        onChange={(event) =>
                                          setDecisions((current) => ({
                                            ...current,
                                            [choiceKey]: {
                                              ...choice,
                                              value: event.target.value,
                                            },
                                          }))
                                        }
                                      />
                                    </label>
                                  )}
                                </>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>
            ))}
          {fieldCount > 0 || !planned.some((row) => row.pendingNew) ? (
            <>
              <label className="field full">
                <span>סיבת השחזור וההכרעות</span>
                <input
                  required
                  maxLength={500}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  disabled={busy}
                />
              </label>
              <label className="check-field full">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                  disabled={busy}
                />
                בדקתי את השדות ואת ההחלטות ומאשר/ת את השחזור
              </label>
              <div className="form-actions full">
                <button className="btn primary" disabled={busy || !confirmed}>
                  אישור שחזור העדכונים
                </button>
              </div>
            </>
          ) : (
            <p className="muted full">
              אין שדות של חיילים קיימים שנותרו לשחזור באצווה הזאת.
            </p>
          )}
        </form>
      )}
    </div>
  );
}
