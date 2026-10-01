"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { DateTime } from "luxon";
import { UNIT_ZONE } from "@/domain/time";
import { draftsInRange, runDrafts } from "@/client/publish-drafts";
import {
  type Action,
  type AppState,
  type Row,
  displayDate,
  num,
  rows,
  str,
} from "@/client/types";
import { Badge, Empty, Notice, Panel } from "./ui";

interface Preview {
  token: string;
  ready: number;
  blocked: number;
  duties: Row[];
}
interface Outcome {
  published: number;
  blocked: { id: string; name: string; reason: string }[];
}

/** Seats held and seats still open in a draft, for the list the manager picks from. */
function seatSummary(state: AppState, duty: Row) {
  const held = state.assignments.filter(
    (row) =>
      row.dutyId === duty.id &&
      !["cancelled", "transferred"].includes(str(row.status))
  ).length;
  const vacant = Math.max(0, rows(duty.slots).length - held);
  return `${held} שיבוצים · ${vacant} מקומות פנויים`;
}

/**
 * Publishing several drafts in one action (decision 197). The manager picks a
 * date range and marks drafts, or arrives from a finished planning run with its
 * drafts marked. A preview says which are ready and which are blocked and why;
 * confirming publishes the ready ones together and leaves the rest as drafts.
 */
export function PublishDrafts({
  state,
  action,
  runId,
}: {
  state: AppState;
  action: Action;
  runId?: string;
}) {
  const run = runId
    ? rows(state.planningRuns).find((row) => row.id === runId)
    : undefined;
  const [start, setStart] = useState(
    () => str(run?.start) || DateTime.now().setZone(UNIT_ZONE).toISODate() || ""
  );
  const [end, setEnd] = useState(
    () =>
      str(run?.end) ||
      DateTime.now().setZone(UNIT_ZONE).plus({ days: 13 }).toISODate() ||
      ""
  );
  // The screen lists what had not started when it opened; the server decides again at publish.
  const [now] = useState(() => Date.now());
  const [marked, setMarked] = useState<string[]>(() =>
    run ? runDrafts(run, state.duties, now).map((row) => row.id) : []
  );
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState<"" | "preview" | "publish">("");
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const all = useRef<HTMLInputElement>(null);

  const drafts = draftsInRange(state.duties, start, end, now);
  const selected = drafts
    .filter((row) => marked.includes(row.id))
    .map((row) => row.id);
  useEffect(() => {
    if (all.current)
      all.current.indeterminate =
        selected.length > 0 && selected.length < drafts.length;
  });

  /** A change to the choice makes a preview, and the approval after it, out of date. */
  const choose = (change: () => void) => {
    change();
    setPreview(null);
    setConfirmed(false);
    setOutcome(null);
  };
  const runPreview = async () => {
    setBusy("preview");
    setOutcome(null);
    try {
      const result = await action("duty.publish.preview", {
        dutyIds: selected,
      });
      setPreview({
        token: str(result.token),
        ready: num(result.ready),
        blocked: num(result.blocked),
        duties: rows(result.duties),
      });
      setConfirmed(false);
    } catch {
      /* Workspace displays the actionable error. */
    } finally {
      setBusy("");
    }
  };
  const publish = async () => {
    if (!preview) return;
    setBusy("publish");
    try {
      const result = await action("duty.publish.batch", {
        dutyIds: preview.duties.map((row) => row.id),
        token: preview.token,
        confirmed: true,
      });
      const blocked = rows(result.blocked).map((row) => ({
        id: row.id,
        name: str(row.name),
        reason: str(row.reason),
      }));
      setOutcome({ published: rows(result.published).length, blocked });
      setMarked(blocked.map((row) => row.id));
      setPreview(null);
      setConfirmed(false);
    } catch {
      // Whatever went wrong, the preview no longer describes the unit: ask for a new one.
      setPreview(null);
      setConfirmed(false);
    } finally {
      setBusy("");
    }
  };

  if (runId && !run)
    return (
      <Panel title="בחירת הטיוטות">
        <Empty
          title="ריצת התכנון לא נמצאה"
          action={
            <Link className="btn primary" href="/manage/publish">
              לפרסום טיוטות לפי תאריכים
            </Link>
          }
        />
      </Panel>
    );
  const readyCount = preview?.ready ?? 0;
  return (
    <Panel
      title="בחירת הטיוטות"
      subtitle="בוחרים טווח תאריכים, מסמנים טיוטות ובודקים לפני הפרסום"
    >
      {run ? (
        <Notice>
          מסומנות הטיוטות של ריצת התכנון מ־{displayDate(run.start)} עד{" "}
          {displayDate(run.end)}. אפשר לשנות את הטווח ואת הסימון.
        </Notice>
      ) : null}
      <div className="form-grid">
        <label className="field">
          <span>מתאריך</span>
          <input
            type="date"
            dir="ltr"
            aria-label="מתאריך"
            value={start}
            onChange={(event) => choose(() => setStart(event.target.value))}
          />
        </label>
        <label className="field">
          <span>עד תאריך</span>
          <input
            type="date"
            dir="ltr"
            aria-label="עד תאריך"
            value={end}
            onChange={(event) => choose(() => setEnd(event.target.value))}
          />
        </label>
      </div>
      {drafts.length ? (
        <fieldset className="draft-picker">
          <legend>טיוטות שמתחילות בטווח</legend>
          <label className="check-field draft-all">
            <input
              ref={all}
              type="checkbox"
              aria-label="בחר הכול"
              checked={selected.length === drafts.length}
              onChange={(event) =>
                choose(() =>
                  setMarked(
                    event.target.checked ? drafts.map((row) => row.id) : []
                  )
                )
              }
            />
            <span>בחר הכול ({drafts.length})</span>
          </label>
          <ul className="draft-list">
            {drafts.map((duty) => (
              <li key={duty.id}>
                <label className="check-field draft-row">
                  <input
                    type="checkbox"
                    aria-label={`${str(duty.name)} · ${displayDate(duty.start, true)}`}
                    checked={marked.includes(duty.id)}
                    onChange={(event) =>
                      choose(() =>
                        setMarked(
                          event.target.checked
                            ? [...marked, duty.id]
                            : marked.filter((item) => item !== duty.id)
                        )
                      )
                    }
                  />
                  <span>
                    {str(duty.name)} · {displayDate(duty.start, true)}
                    <small>{seatSummary(state, duty)}</small>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      ) : (
        <Empty
          title="אין טיוטות עתידיות שמתחילות בטווח"
          text="אפשר להרחיב את הטווח."
        />
      )}
      <div className="form-actions">
        <button
          className="btn secondary"
          type="button"
          disabled={!selected.length || Boolean(busy)}
          onClick={() => void runPreview()}
        >
          {busy === "preview" ? "בודקים…" : `תצוגה מקדימה (${selected.length})`}
        </button>
      </div>
      {outcome ? (
        <Notice tone={outcome.blocked.length ? "warning" : "success"}>
          <p>
            {outcome.published === 1
              ? "פורסמה תורנות אחת."
              : `פורסמו ${outcome.published} תורנויות.`}
            {outcome.blocked.length
              ? ` ${outcome.blocked.length} נשארו טיוטה:`
              : ""}
          </p>
          {outcome.blocked.length ? (
            <ul className="plain-list">
              {outcome.blocked.map((row) => (
                <li key={row.id}>
                  <Link className="text-link" href={`/duties/${row.id}`}>
                    {row.name}
                  </Link>
                  : {row.reason}
                </li>
              ))}
            </ul>
          ) : null}
        </Notice>
      ) : null}
      {preview ? (
        <section className="subsection" aria-label="תצוגה מקדימה של הפרסום">
          <h3>תצוגה מקדימה</h3>
          <p role="status">
            {preview.ready} מוכנות לפרסום · {preview.blocked} חסומות
            {preview.blocked ? " ויישארו טיוטה" : ""}
          </p>
          <ul className="draft-list">
            {preview.duties.map((duty) => (
              <li className="draft-row preview-row" key={duty.id}>
                <Badge tone={duty.ready ? "success" : "danger"}>
                  {duty.ready ? "מוכנה" : "חסומה"}
                </Badge>
                <span>
                  {str(duty.name)} · {displayDate(duty.start, true)}
                  {duty.ready && num(duty.vacant) > 0 ? (
                    <small>{num(duty.vacant)} מקומות עדיין פנויים</small>
                  ) : null}
                  {!duty.ready ? <small>{str(duty.reason)}</small> : null}
                </span>
              </li>
            ))}
          </ul>
          <label className="check-field">
            <input
              type="checkbox"
              aria-label="בדקתי את הטיוטות המוכנות והשיבוצים שבהן"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            <span>בדקתי את הטיוטות המוכנות והשיבוצים שבהן</span>
          </label>
          <div className="form-actions">
            <button
              className="btn primary"
              type="button"
              disabled={!confirmed || readyCount === 0 || Boolean(busy)}
              onClick={() => void publish()}
            >
              {busy === "publish"
                ? "מפרסמים…"
                : readyCount === 1
                  ? "פרסום תורנות מוכנה אחת"
                  : `פרסום ${readyCount} תורנויות מוכנות`}
            </button>
          </div>
        </section>
      ) : null}
    </Panel>
  );
}
