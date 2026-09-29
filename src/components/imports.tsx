"use client";
import { useState, type FormEvent } from "react";
import {
  type Action,
  type AppState,
  type Row,
  obj,
  rows,
  str,
  num,
  displayDate,
} from "@/client/types";
import { Empty, Notice, Panel, Status } from "./ui";
import { importValue } from "@/client/import-values";
import { ImportRestore } from "./import-restores";
import { AffectedAssignments, PopulationChange } from "./personnel-history";
export function ImportsView({
  state,
  action,
  reload,
}: {
  state: AppState;
  action: Action;
  reload: () => Promise<void>;
}) {
  const [batch, setBatch] = useState<Record<string, unknown>>();
  const [error, setError] = useState("");
  const [problems, setProblems] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [overwrite, setOverwrite] = useState(false);
  const [populationConfirmed, setPopulationConfirmed] = useState(false);
  const [reason, setReason] = useState("");
  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setProblems([]);
    setBatch(undefined);
    setConfirmed(false);
    setOverwrite(false);
    setPopulationConfirmed(false);
    setReason("");
    const form = new FormData(event.currentTarget);
    form.set("idempotencyKey", crypto.randomUUID());
    try {
      const response = await fetch("/api/v1/imports", {
        method: "POST",
        body: form,
      });
      const body = await response.json();
      if (!response.ok) {
        setProblems(rows(body.error?.details?.problems));
        throw new Error(str(body.error?.message, "הקובץ לא נקרא"));
      }
      setBatch(obj(body.result));
      await reload();
    } catch (error) {
      setError(error instanceof Error ? error.message : "הייבוא לא הושלם");
    } finally {
      setBusy(false);
    }
  }
  async function open(id: string) {
    setBusy(true);
    setError("");
    setProblems([]);
    setConfirmed(false);
    setOverwrite(false);
    setPopulationConfirmed(false);
    setReason("");
    try {
      setBatch(await action("import.get", { id }));
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "לא ניתן לפתוח את הייבוא"
      );
    } finally {
      setBusy(false);
    }
  }
  async function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!batch) return;
    setBusy(true);
    setError("");
    try {
      setBatch(
        await action(
          "import.apply",
          {
            id: batch.id,
            confirmed,
            overwriteConfirmed: overwrite,
            populationImpactConfirmed: populationConfirmed,
            reason,
          },
          num(batch.version)
        )
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : "הייבוא לא הושלם");
    } finally {
      setBusy(false);
    }
  }
  const details = rows(batch?.rows);
  const hasOverwrite = details.some(
    (row) => row.mode === "update" && rows(row.changes).length > 0
  );
  const hasPopulationMove = details.some((row) => row.populationImpact);
  return (
    <>
      <Panel
        title="ייבוא Excel"
        subtitle="קליטה ועדכון לפי מספר אישי, עם אישור לפני שמירה"
        actions={
          <a
            className="btn secondary"
            href="/api/v1/imports/template"
            download="fair-shifts-import.xlsx"
          >
            הורדת תבנית XLSX
          </a>
        }
      >
        <p className="muted">
          תא ריק אינו מוחק מידע קיים. מספר אישי וטלפון נשמרים כטקסט; ניקוד נוכחי
          אינו כולל ניקוד שמור.
        </p>
        <form onSubmit={upload} className="form-grid">
          <label className="field full">
            <span>קובץ XLSX</span>
            <input
              name="file"
              type="file"
              accept=".xlsx"
              required
              disabled={busy}
            />
          </label>
          <div className="form-actions full">
            <button className="btn primary" disabled={busy}>
              {busy ? "בודק…" : "הצגת תצוגה מקדימה"}
            </button>
          </div>
        </form>
      </Panel>
      {error && <Notice tone="danger">{error}</Notice>}
      {problems.length > 0 && (
        <Panel title="שגיאות בקובץ">
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>שורה</th>
                  <th>שדה</th>
                  <th>ערך</th>
                  <th>סיבה</th>
                  <th>תיקון</th>
                </tr>
              </thead>
              <tbody>
                {problems.map((problem, index) => (
                  <tr key={index}>
                    <td>{str(problem.row)}</td>
                    <td>{str(problem.field)}</td>
                    <td>{str(problem.value)}</td>
                    <td>{str(problem.reason)}</td>
                    <td>{str(problem.fix)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
      {batch && (
        <Panel
          title={
            batch.status === "preview"
              ? "תצוגה מקדימה — טרם נשמרו חיילים"
              : "תוצאות הייבוא"
          }
          subtitle={`${str(batch.filename)} · ${num(batch.created)} חדשים · ${num(batch.updated)} מעודכנים`}
        >
          {details.map((row) => (
            <section key={row.id} className="task-item">
              <div className="grow">
                <h3>
                  {str(row.name)} ·{" "}
                  <bdi>{str(obj(row.values).personalNumber)}</bdi> ·{" "}
                  {row.mode === "create" ? "קליטה חדשה" : "עדכון קיים"}
                </h3>
                {rows(row.changes).length ? (
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>שדה</th>
                          <th>לפני</th>
                          <th>אחרי</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows(row.changes).map((change) => (
                          <tr key={str(change.key)}>
                            <td>{str(change.label)}</td>
                            <td>
                              {importValue(
                                change.before,
                                str(change.key),
                                state
                              )}
                            </td>
                            <td>
                              {importValue(
                                change.after,
                                str(change.key),
                                state
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="muted">אין שינויים בשורה הזאת</p>
                )}
                {row.newRowRestored ? (
                  <p className="muted">
                    {
                      {
                        cancelled:
                          "הקליטה בוטלה בשחזור. פרטי הקשר הוסרו מהשורה.",
                        kept: "החייל נשאר במערכת בהכרעת שחזור.",
                        erased:
                          "החייל נמחק במסלול המחיקה; השורה נסגרה בלי פעולה.",
                      }[str(obj(row.newRowRestored).action)]
                    }
                  </p>
                ) : null}
                {batch.status === "preview" && row.populationImpact ? (
                  <div
                    className="stack"
                    role="region"
                    aria-label={`מעבר אוכלוסייה — ${str(row.name)}`}
                  >
                    <h4>השורה מזיזה את אוכלוסיית השיבוץ</h4>
                    <PopulationChange change={row.populationImpact} />
                    <AffectedAssignments
                      impact={rows(obj(row.populationImpact).impact)}
                      empty="המעבר אינו משנה את ההתאמה של שיבוצים קיימים."
                    />
                  </div>
                ) : null}
              </div>
            </section>
          ))}
          {batch.status === "preview" ? (
            <form onSubmit={apply} className="form-grid">
              <label className="field full">
                <span>סיבת הייבוא</span>
                <input
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  required
                  maxLength={500}
                  disabled={busy}
                />
              </label>
              {hasOverwrite && (
                <label className="check-field full">
                  <input
                    type="checkbox"
                    checked={overwrite}
                    onChange={(event) => setOverwrite(event.target.checked)}
                    disabled={busy}
                  />
                  אני מאשר/ת דריסת השדות והיתרות הקיימים המוצגים
                </label>
              )}
              {hasPopulationMove && (
                <label className="check-field full">
                  <input
                    type="checkbox"
                    checked={populationConfirmed}
                    onChange={(event) =>
                      setPopulationConfirmed(event.target.checked)
                    }
                    disabled={busy}
                  />
                  בדקתי את מעברי האוכלוסייה ואת השיבוצים שיסומנו לטיפול
                </label>
              )}
              <label className="check-field full">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                  disabled={busy}
                />
                בדקתי את כל השורות ואת ברירות המחדל לקליטה חדשה
              </label>
              <div className="form-actions full">
                <button
                  className="btn primary"
                  disabled={
                    busy ||
                    !confirmed ||
                    (hasOverwrite && !overwrite) ||
                    (hasPopulationMove && !populationConfirmed)
                  }
                >
                  אישור ושמירת הייבוא
                </button>
              </div>
            </form>
          ) : (
            <Notice tone="success">
              {batch.status === "restored"
                ? "שחזור הייבוא הושלם: כל השורות טופלו."
                : batch.status === "partially_restored"
                  ? "השחזור בוצע בחלקו. קליטות עם פעילות ממתינות להכרעה בבדיקת שחזור חוזרת."
                  : "הייבוא נשמר בשלמותו. שינויי היתרה מתועדים ביומן; השיבוצים והניקוד השמור נשמרו."}
            </Notice>
          )}
          <ImportRestore
            key={`${str(batch.id)}:${num(batch.version)}`}
            batch={batch}
            state={state}
            action={action}
            onChange={setBatch}
          />
        </Panel>
      )}
      <Panel title="אצוות ייבוא">
        {state.imports.length ? (
          state.imports.map((row) => (
            <div className="task-item" key={row.id}>
              <div className="grow">
                <strong>{str(row.filename)}</strong>
                <p className="muted">
                  {num(row.created)} חדשים · {num(row.updated)} מעודכנים ·{" "}
                  {displayDate(row.appliedAt ?? row.expiresAt, true)}
                </p>
              </div>
              <Status value={row.status} />
              <button
                className="btn secondary"
                onClick={() => open(row.id)}
                disabled={busy}
              >
                הצגת האצווה
              </button>
            </div>
          ))
        ) : (
          <Empty title="אין אצוות ייבוא" />
        )}
      </Panel>
    </>
  );
}
