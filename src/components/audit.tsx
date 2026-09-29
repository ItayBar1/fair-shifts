"use client";
import Link from "next/link";
import { useState } from "react";
import {
  type AppState,
  displayDate,
  rows,
  str,
  type Row,
} from "@/client/types";
import { Badge, Empty, Panel } from "./ui";

/** The path that shows the audit entries reachable from a soldier, duty, decision or other record. */
export const auditHref = (id: unknown) => `/manage/audit/${str(id)}`;

export function AuditLink({
  id,
  label = "תיעוד",
}: {
  id: unknown;
  label?: string;
}) {
  return (
    <Link className="text-link" href={auditHref(id)}>
      {label}
    </Link>
  );
}

const refsOf = (entry: Row) =>
  Array.isArray(entry.refs) ? entry.refs.map(String) : [];

function subjectTitle(state: AppState, id: string) {
  const soldier = state.soldiers.find((row) => row.id === id);
  if (soldier) return `החייל ${str(soldier.name)}`;
  const duty = state.duties.find((row) => row.id === id);
  if (duty) return `התורנות ${str(duty.name)}`;
  return "הרשומה שנבחרה";
}

function Entry({ state, entry }: { state: AppState; entry: Row }) {
  const manager = state.actor.role === "manager";
  const otherManager =
    entry.actorRole === "manager" && entry.actorId !== state.actor.id;
  const changes = rows(entry.changes);
  const details = rows(entry.details);
  return (
    <article className="audit-entry" aria-label={str(entry.label)}>
      <header className="audit-head">
        <strong>{str(entry.label)}</strong>
        {otherManager && <Badge tone="info">אחראי אחר</Badge>}
        {entry.actorId === state.actor.id && <Badge>אני</Badge>}
        {entry.detailRemoved === true && (
          <Badge tone="warning">הפירוט האישי הוסר</Badge>
        )}
      </header>
      <dl className="audit-meta">
        <div>
          <dt>נרשם</dt>
          <dd>{displayDate(entry.recordedAt, true)}</dd>
        </div>
        {Boolean(entry.effectiveAt) && (
          <div>
            <dt>מועד תחולה</dt>
            <dd>
              {displayDate(
                entry.effectiveAt,
                str(entry.effectiveAt).length > 10
              )}
            </dd>
          </div>
        )}
        <div>
          <dt>בוצע בידי</dt>
          <dd>{str(entry.actorName, "—")}</dd>
        </div>
        {Boolean(entry.soldierName) && (
          <div>
            <dt>חייל</dt>
            <dd>
              {manager ? (
                <Link className="text-link" href={auditHref(entry.soldierId)}>
                  {str(entry.soldierName)}
                </Link>
              ) : (
                str(entry.soldierName)
              )}
            </dd>
          </div>
        )}
        {Boolean(entry.dutyName) && (
          <div>
            <dt>תורנות</dt>
            <dd>
              <Link className="text-link" href={`/duties/${str(entry.dutyId)}`}>
                {str(entry.dutyName)}
              </Link>
            </dd>
          </div>
        )}
        {entry.version !== undefined && (
          <div>
            <dt>גרסה עסקית</dt>
            <dd>{str(entry.version)}</dd>
          </div>
        )}
        {details.map((item, index) => (
          <div key={index}>
            <dt>{str(item.label)}</dt>
            <dd>{str(item.value)}</dd>
          </div>
        ))}
      </dl>
      {changes.length > 0 && (
        <div className="table-scroll">
          <table className="audit-changes">
            <thead>
              <tr>
                <th>שדה</th>
                <th>לפני</th>
                <th>אחרי</th>
              </tr>
            </thead>
            <tbody>
              {changes.map((item, index) => (
                <tr key={index}>
                  <td>{str(item.label)}</td>
                  <td>{str(item.before)}</td>
                  <td>{str(item.after)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {Boolean(entry.reason) && (
        <p className="audit-reason">
          <span>סיבה:</span> {str(entry.reason)}
        </p>
      )}
    </article>
  );
}

export function AuditView({
  state,
  refId,
  title = "יומן פעולות",
}: {
  state: AppState;
  refId?: string;
  title?: string;
}) {
  const [query, setQuery] = useState("");
  const all = rows(state.audit);
  const scoped = refId
    ? all.filter((entry) => refsOf(entry).includes(refId))
    : all;
  const needle = query.trim();
  const shown = needle
    ? scoped.filter((entry) =>
        [
          entry.label,
          entry.actorName,
          entry.soldierName,
          entry.dutyName,
          entry.reason,
        ]
          .map((value) => str(value))
          .some((value) => value.includes(needle))
      )
    : scoped;
  const home =
    state.actor.role === "technical" ? "/technical/audit" : "/manage/audit";
  return (
    <Panel
      title={refId ? `תיעוד עבור ${subjectTitle(state, refId)}` : title}
      subtitle="מועד רישום, מבצע, סיבה ומה השתנה. מועד תחולה מוצג כשהוא שונה ממועד הרישום."
      actions={
        refId ? (
          <Link className="text-link" href={home}>
            הצגת כל היומן
          </Link>
        ) : undefined
      }
    >
      <label className="field audit-search">
        <span>חיפוש לפי פעולה, מבצע, חייל או תורנות</span>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      {shown.length ? (
        <div className="audit-list">
          {shown.map((entry) => (
            <Entry key={entry.id} state={state} entry={entry} />
          ))}
        </div>
      ) : (
        <Empty
          title="אין פעולות להצגה"
          text={refId || needle ? "לא נמצא תיעוד שמתאים לבחירה." : undefined}
        />
      )}
    </Panel>
  );
}

/**
 * The record a score ledger row came from, by its source key: the assignment,
 * decision, correction, adjustment or import batch (an opening names the soldier).
 */
export function ledgerSource(row: Row) {
  return str(row.sourceKey).split(":")[1] || undefined;
}
