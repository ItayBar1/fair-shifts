"use client";
import { useState } from "react";
import { Search } from "lucide-react";
import {
  type Action,
  type AppState,
  type Row,
  displayDate,
  num,
  personName,
  str,
} from "@/client/types";
import {
  type LedgerColumn,
  type LedgerFilter,
  type Sort,
  ledgerKind,
  ledgerKinds,
  ledgerView,
  nextSort,
  noLedgerFilter,
  shownScore,
} from "@/client/fairness";
import { effectiveDiffers } from "@/domain/time";
import { AuditLink, ledgerSource } from "../audit";
import { LoadOlder } from "../load-older";
import { Empty, Notice, scrollRegion } from "../ui";

import { ScoreChange } from "./score-change";
import { SortHead } from "./sort-head";

export function LedgerTable({
  state,
  entries,
  soldierColumn,
  sourceColumn,
}: {
  state: AppState;
  entries: Row[];
  soldierColumn: boolean;
  sourceColumn: boolean;
}) {
  const [sort, setSort] = useState<Sort<LedgerColumn>>({
    key: "effectiveAt",
    direction: "desc",
  });
  const onSort = (column: LedgerColumn) => setSort(nextSort(sort, column));
  const shown = ledgerView(
    entries,
    (id) => personName(state, id),
    noLedgerFilter,
    sort
  );
  const head = (label: string, column: LedgerColumn) => (
    <SortHead label={label} column={column} sort={sort} onSort={onSort} />
  );
  if (!entries.length) return <Empty title="אין פעולות ניקוד" />;
  return (
    <div className="table-scroll" {...scrollRegion("יומן הניקוד")}>
      <table className="ledger-table stack-on-phone">
        <thead>
          <tr>
            {soldierColumn && head("חייל", "soldier")}
            {head("סוג", "kind")}
            {head("מועד תחולה", "effectiveAt")}
            {soldierColumn && sourceColumn && head("נרשם", "recordedAt")}
            {head("שינוי", "amount")}
            {head("יתרה", "after")}
            {sourceColumn && head("סיבה", "reason")}
            {sourceColumn && <th>פירוט הפעולה</th>}
          </tr>
        </thead>
        <tbody>
          {shown.map((row) => (
            <tr key={row.id}>
              {soldierColumn && (
                <td data-label="חייל">{personName(state, row.soldierId)}</td>
              )}
              <td data-label="סוג">{ledgerKind(row)}</td>
              <td data-label="מועד תחולה">
                {displayDate(row.effectiveAt, true)}
              </td>
              {soldierColumn && sourceColumn && (
                <td data-label="נרשם">
                  {effectiveDiffers(str(row.effectiveAt), str(row.recordedAt))
                    ? displayDate(row.recordedAt, true)
                    : "באותו מועד"}
                </td>
              )}
              <td data-label="שינוי" className="amount">
                {/* The sign stays before the number in a right-to-left line. */}
                <span dir="ltr">
                  {num(row.amount) > 0
                    ? `+${num(row.amount)}`
                    : num(row.amount)}
                </span>
              </td>
              <td data-label="יתרה">{num(row.after)}</td>
              {sourceColumn && (
                <td data-label="סיבה" className="reason">
                  {str(row.reason, "—")}
                </td>
              )}
              {sourceColumn && (
                <td data-label="פירוט הפעולה">
                  {ledgerSource(row) ? (
                    <AuditLink id={ledgerSource(row)} label="פירוט הפעולה" />
                  ) : (
                    "—"
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The whole unit's ledger, filtered and sorted like a spreadsheet. */
export function UnitLedger({ state }: { state: AppState }) {
  const [filter, setFilter] = useState<LedgerFilter>(noLedgerFilter);
  const set = (part: Partial<LedgerFilter>) =>
    setFilter((current) => ({ ...current, ...part }));
  const filtered = ledgerView(
    state.ledger,
    (id) => personName(state, id),
    filter,
    { key: "effectiveAt", direction: "desc" }
  );
  const active =
    filter.text || filter.kind || filter.from || filter.to ? true : false;
  return (
    <>
      <div className="filters" role="search" aria-label="סינון יומן הניקוד">
        <label className="search">
          <Search size={17} />
          <input
            aria-label="חיפוש לפי חייל או סיבה"
            placeholder="חיפוש לפי חייל או סיבה…"
            value={filter.text}
            onChange={(e) => set({ text: e.target.value })}
          />
        </label>
        <select
          aria-label="סינון לפי סוג"
          value={filter.kind}
          onChange={(e) => set({ kind: e.target.value })}
        >
          <option value="">כל הסוגים</option>
          {[...new Set(Object.values(ledgerKinds))].map((label) => (
            <option key={label} value={label}>
              {label}
            </option>
          ))}
        </select>
        <label className="date-filter">
          <span>מתאריך</span>
          <input
            type="date"
            dir="ltr"
            aria-label="מתאריך"
            value={filter.from}
            onChange={(e) => set({ from: e.target.value })}
          />
        </label>
        <label className="date-filter">
          <span>עד תאריך</span>
          <input
            type="date"
            dir="ltr"
            aria-label="עד תאריך"
            value={filter.to}
            onChange={(e) => set({ to: e.target.value })}
          />
        </label>
        {active && (
          <button
            type="button"
            className="text-button"
            onClick={() => setFilter(noLedgerFilter)}
          >
            ניקוי הסינון
          </button>
        )}
      </div>
      <p className="muted" role="status">
        {filtered.length} מתוך {state.ledger.length} פעולות
      </p>
      {filtered.length || !state.ledger.length ? (
        <LedgerTable
          state={state}
          entries={filtered}
          soldierColumn
          sourceColumn
        />
      ) : (
        <Empty
          title="אין פעולות שמתאימות לסינון"
          text="אפשר לשנות את הסינון או לנקות אותו."
        />
      )}
    </>
  );
}

/** One soldier's points: the balance, the points ahead, the history and, for a manager, a change. */
export function SoldierScore({
  state,
  action,
  soldier,
  onDone,
}: {
  state: AppState;
  action: Action;
  soldier: Row & { rank?: number };
  onDone: () => void;
}) {
  const manager = state.actor.role === "manager";
  const frozen = Boolean(soldier.isManager);
  const entries = state.ledger.filter((row) => row.soldierId === soldier.id);
  return (
    <div className="stack">
      <dl className="score-summary">
        <div>
          <dt>יתרה נוכחית</dt>
          <dd className="score-number">{num(soldier.currentScore)}</dd>
        </div>
        <div>
          <dt>
            {manager ? "שמור לשיבוצים, כולל טיוטות" : "בתורנויות שפורסמו"}
          </dt>
          <dd>{num(soldier.futureScore)}</dd>
        </div>
        <div>
          <dt>כולל עתידי</dt>
          <dd>{shownScore(soldier, true)}</dd>
        </div>
        <div>
          <dt>דירוג</dt>
          <dd>{frozen ? "ללא דירוג" : str(soldier.rank, "—")}</dd>
        </div>
      </dl>
      {frozen && (
        <Notice>
          אחראי תורנויות אינו משובץ, והיתרה שלו מוקפאת כל עוד הוא אחראי.
        </Notice>
      )}
      {manager && !frozen && (
        <section aria-label="שינוי יתרה">
          <h3>שינוי יתרה</h3>
          <ScoreChange
            state={state}
            action={action}
            soldierIds={[soldier.id]}
            onDone={onDone}
          />
        </section>
      )}
      <section aria-label="יומן הניקוד">
        <h3>יומן הניקוד</h3>
        <LedgerTable
          state={state}
          entries={entries}
          soldierColumn={false}
          sourceColumn={manager}
        />
        <LoadOlder what="פעולות" />
      </section>
    </div>
  );
}

/**
 * The shared fairness table, with the score ledger folded in (decision 220).
 * Everyone sorts, filters and may add the points ahead; a soldier opens only
 * their own row. A manager opens any soldier, changes a balance in its cell
 * or for a selection, and reads the whole unit's ledger.
 */
