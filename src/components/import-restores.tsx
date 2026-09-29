"use client";
import { useState, type FormEvent } from "react";
import {
  type Action,
  type AppState,
  obj,
  rows,
  str,
  num,
} from "@/client/types";
import { importValue } from "@/client/import-values";
import { AffectedAssignments, PopulationChange } from "./personnel-history";
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
  const [populationConfirmed, setPopulationConfirmed] = useState(false);
  // A changed decision on a profile field may change the population impact.
  const [impactStale, setImpactStale] = useState(false);
  const [decisions, setDecisions] = useState<
    Record<string, { action: string; value?: string }>
  >({});
  const [creations, setCreations] = useState<Record<string, string>>({});
  function choices() {
    return rows(preview?.rows).flatMap((row) =>
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
  }
  async function prepare(withDecisions: boolean) {
    setBusy(true);
    setError("");
    setConfirmed(false);
    setPopulationConfirmed(false);
    if (!withDecisions) {
      setDecisions({});
      setCreations({});
    }
    try {
      setPreview(
        await action(
          "import.restore.preview",
          { id: batch.id, decisions: withDecisions ? choices() : [] },
          num(batch.version)
        )
      );
      setImpactStale(false);
    } catch (error) {
      setError(error instanceof Error ? error.message : "לא ניתן להכין שחזור");
    } finally {
      setBusy(false);
    }
  }
  function decide(
    key: string,
    source: unknown,
    choice: { action: string; value?: string }
  ) {
    setDecisions((current) => ({ ...current, [key]: choice }));
    if (source === "person") {
      setImpactStale(true);
      setPopulationConfirmed(false);
    }
  }
  async function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!preview) return;
    setBusy(true);
    setError("");
    try {
      onChange(
        await action(
          "import.restore",
          {
            id: batch.id,
            token: preview.token,
            reason,
            confirmed,
            populationImpactConfirmed: populationConfirmed,
            decisions: choices(),
            creations: Object.entries(creations)
              .filter(([, choice]) => choice === "keep")
              .map(([rowId]) => ({ rowId, action: "keep" })),
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
  const created = planned.filter((row) => row.creation);
  const creationStatus = (row: Record<string, unknown>) =>
    str((row.creation as Record<string, unknown>).status);
  const actionable =
    fieldCount > 0 ||
    created.some((row) => creationStatus(row) !== "activity") ||
    Object.values(creations).includes("keep");
  const hasPopulationMove = planned.some((row) => row.populationImpact);
  return (
    <div className="import-restore">
      <button
        type="button"
        className="btn secondary"
        disabled={busy}
        onClick={() => prepare(false)}
      >
        בדיקת שחזור הייבוא
      </button>
      {error && <Notice tone="danger">{error}</Notice>}
      {preview && (
        <form onSubmit={apply} className="form-grid">
          <h3 className="full">בדיקת שחזור — לפי השינויים מאז הייבוא</h3>
          {fieldCount > 0 && (
            <div className="full">
              <Notice>
                שדות שלא השתנו ניתנים לשחזור. לכל התנגשות נדרשת הכרעה נפרדת.
                תורנויות ופעולות ניקוד מאוחרות נשמרות; השחזור מוסיף פעולה
                מתועדת. שחזור שמזיז אוכלוסיית שיבוץ מציג את השיבוצים שיסומנו
                ״דורש טיפול״ ודורש אישור נפרד. התנגשות שטרם הוכרעה נחשבת בינתיים
                כהשארת הערך הנוכחי.
              </Notice>
            </div>
          )}
          {created.length > 0 && (
            <section
              className="full"
              role="region"
              aria-label="קליטות חדשות באצווה"
            >
              <h3>קליטות חדשות</h3>
              <Notice>
                קליטה בלי פעילות מאז הייבוא תבוטל בהסרה מלאה: החייל, פרטי הקשר,
                היתרה, החשבון וההזמנה, והמספר האישי יתפנה. בשורת הייבוא יישארו
                השם, המספר האישי ותוצאת השחזור. חייל עם פעילות נשאר עד שתבחרו
                להשאיר אותו; מחיקת משתמש תתווסף כאן עם מסלול המחיקה.
              </Notice>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>חייל</th>
                      <th>מספר אישי</th>
                      <th>מצב</th>
                      <th>פעילות מאז הייבוא</th>
                      <th>החלטה</th>
                    </tr>
                  </thead>
                  <tbody>
                    {created.map((row) => {
                      const status = creationStatus(row);
                      const activity = (
                        (row.creation as Record<string, unknown>)
                          .activity as unknown[]
                      ).map((item) => str(item));
                      return (
                        <tr key={row.id}>
                          <td>
                            {str(row.name)} · שורה {num(row.rowNumber)}
                          </td>
                          <td>
                            <bdi>{str(row.personalNumber)}</bdi>
                          </td>
                          <td>
                            <Badge
                              tone={
                                status === "cancel"
                                  ? "success"
                                  : status === "activity"
                                    ? "warning"
                                    : "danger"
                              }
                            >
                              {status === "cancel"
                                ? "הקליטה תבוטל"
                                : status === "activity"
                                  ? "יש פעילות"
                                  : "נמחק במסלול המחיקה"}
                            </Badge>
                          </td>
                          <td>{activity.join(" · ") || "אין"}</td>
                          <td>
                            {status === "activity" ? (
                              <select
                                aria-label={`החלטה עבור קליטת ${str(row.name)}`}
                                value={creations[row.id] ?? ""}
                                disabled={busy}
                                onChange={(event) =>
                                  setCreations((current) => ({
                                    ...current,
                                    [row.id]: event.target.value,
                                  }))
                                }
                              >
                                <option value="">להכריע מאוחר יותר</option>
                                <option value="keep">להשאיר את החייל</option>
                              </select>
                            ) : status === "cancel" ? (
                              "ביטול עם אישור השחזור"
                            ) : (
                              "נסגר בלי פעולה"
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
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
                                        decide(choiceKey, field.source, {
                                          action: event.target.value,
                                          value:
                                            field.source === "score"
                                              ? str(field.current)
                                              : undefined,
                                        })
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
                {row.populationImpact && !impactStale ? (
                  <div
                    className="stack"
                    role="region"
                    aria-label={`מעבר אוכלוסייה בשחזור — ${str(row.name)}`}
                  >
                    <h4>השחזור מזיז את אוכלוסיית השיבוץ</h4>
                    <PopulationChange change={row.populationImpact} />
                    <AffectedAssignments
                      impact={rows(obj(row.populationImpact).impact)}
                      empty="המעבר אינו משנה את ההתאמה של שיבוצים קיימים."
                    />
                  </div>
                ) : null}
              </section>
            ))}
          {impactStale && (
            <div className="full stack">
              <Notice tone="warning">
                ההכרעות בשדות הפרופיל השתנו. יש לחשב מחדש את השפעת השחזור על
                אוכלוסיית השיבוץ ועל השיבוצים לפני האישור.
              </Notice>
              <div className="form-actions">
                <button
                  type="button"
                  className="btn secondary"
                  disabled={busy}
                  onClick={() => prepare(true)}
                >
                  חישוב השפעה לפי ההכרעות
                </button>
              </div>
            </div>
          )}
          {actionable || !created.length ? (
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
              {hasPopulationMove && !impactStale && (
                <label className="check-field full">
                  <input
                    type="checkbox"
                    checked={populationConfirmed}
                    onChange={(event) =>
                      setPopulationConfirmed(event.target.checked)
                    }
                    disabled={busy}
                  />
                  בדקתי את מעברי האוכלוסייה ואת השיבוצים שיסומנו ״דורש טיפול״,
                  ומאשר/ת אותם
                </label>
              )}
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
                <button
                  className="btn primary"
                  disabled={
                    busy ||
                    !confirmed ||
                    impactStale ||
                    (hasPopulationMove && !populationConfirmed)
                  }
                >
                  אישור השחזור
                </button>
              </div>
            </>
          ) : (
            <p className="muted full">
              אין שדות לשחזור, וכל הקליטות שנותרו ממתינות להכרעה. בחרו ״להשאיר
              את החייל״ בשורה כדי לסגור אותה.
            </p>
          )}
        </form>
      )}
    </div>
  );
}
