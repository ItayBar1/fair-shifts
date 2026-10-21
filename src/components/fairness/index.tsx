"use client";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { BandStrip } from "../views/band-strip";
import { BookOpen, Pencil, Search } from "lucide-react";
import {
  type Action,
  type AppState,
  type Row,
  num,
  population,
  str,
} from "@/client/types";
import {
  type FairnessColumn,
  type FairnessRow,
  type Sort,
  fairnessTable,
  nextSort,
  sortFairness,
} from "@/client/fairness";
import {
  Badge,
  Empty,
  Modal,
  Notice,
  Panel,
  populations,
  scrollRegion,
} from "../ui";
import { HeldFilters } from "../held-filters";
import { holds, noHeldFilter } from "@/client/soldier-filters";

import { EditingRow } from "./editing-row";
import { SoldierScore, UnitLedger } from "./ledger";
import { ScoreChange } from "./score-change";
import { SortHead } from "./sort-head";

export function FairnessView({
  state,
  action,
}: {
  state: AppState;
  action: Action;
}) {
  const manager = state.actor.role === "manager";
  useEffect(() => {
    if (window.location.hash !== "#my-score") return;
    const row = document.getElementById("my-score");
    row?.scrollIntoView({ block: "center" });
    row?.focus({ preventScroll: true });
  }, []);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("");
  // Managers only: a soldier's state carries no capabilities or exemptions.
  const [held, setHeld] = useState(noHeldFilter);
  const [future, setFuture] = useState(false);
  const [sort, setSort] = useState<Sort<FairnessColumn>>({
    key: "rank",
    direction: "asc",
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [opened, setOpened] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [bulk, setBulk] = useState(false);
  const [unitLedger, setUnitLedger] = useState(false);
  const { ranked, managers } = useMemo(
    () => fairnessTable(state.soldiers, future),
    [state.soldiers, future]
  );
  const matches = (s: Row) =>
    str(s.name).includes(search) &&
    (!filter || s.population === filter) &&
    (!manager || holds(s, held));
  const filtered = sortFairness(ranked.filter(matches), sort);
  const outside = managers.filter(matches);
  // A selection counts only what the filters still show.
  const chosen = filtered.filter((s) => selected.has(s.id));
  const allChosen = filtered.length > 0 && chosen.length === filtered.length;
  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const columns = manager ? 6 : 5;
  const openedRow =
    [...ranked, ...managers].find((row) => row.id === opened) ?? null;
  const canOpen = (s: Row) => manager || s.id === state.actor.soldierId;
  const onSort = (column: FairnessColumn) => setSort(nextSort(sort, column));
  const head = (label: string, column: FairnessColumn, className: string) => (
    <SortHead
      label={label}
      column={column}
      sort={sort}
      onSort={onSort}
      className={className}
    />
  );

  const nameCell = (s: Row, marks: ReactNode) => (
    <td className="cell-name">
      <span className="person">
        <span className="avatar small">{str(s.name).slice(0, 1)}</span>
        {canOpen(s) ? (
          <button
            type="button"
            className="name-button"
            onClick={() => setOpened(s.id)}
            aria-label={`הניקוד של ${str(s.name)}`}
          >
            <strong>{str(s.name)}</strong>
          </button>
        ) : (
          <strong>{str(s.name)}</strong>
        )}
        {s.id === state.actor.soldierId && <Badge tone="info">אני</Badge>}
        {marks}
      </span>
    </td>
  );
  const own = (s: Row) =>
    s.id === state.actor.soldierId ? { id: "my-score", tabIndex: -1 } : {};

  const body: ReactNode[] = [];
  const rankedRow = (s: FairnessRow, scoreCell: ReactNode) => (
    <tr
      key={s.id}
      {...own(s)}
      className={`${s.id === state.actor.soldierId ? "personal-row" : ""} ${selected.has(s.id) ? "selected-row" : ""}`}
    >
      {manager && (
        <td className="cell-select">
          <input
            type="checkbox"
            aria-label={`בחירת ${str(s.name)}`}
            checked={selected.has(s.id)}
            onChange={() => toggle(s.id)}
          />
        </td>
      )}
      <td className="cell-place">
        {/* "rank" here is the place in this table, never a military rank. */}
        <span className="rank-number">{s.rank}</span>
      </td>
      {nameCell(s, null)}
      <td className="cell-population">{population(s.population)}</td>
      <td className="cell-rank">{str(s.rankName, "—")}</td>
      <td className="cell-score">
        {scoreCell}
        {future && num(s.futureScore) > 0 && (
          <small className="muted future-part">
            {" "}
            נוכחי {num(s.currentScore)} · עתידי {num(s.futureScore)}
          </small>
        )}
      </td>
    </tr>
  );
  for (const s of filtered) {
    // The balance is edited in its cell only while the cell shows the balance.
    const editable = manager && !future;
    body.push(
      editable && editing === s.id ? (
        <EditingRow
          key={s.id}
          action={action}
          soldier={s}
          columns={columns}
          render={(cell) => rankedRow(s, cell)}
          onClose={() => setEditing(null)}
        />
      ) : (
        rankedRow(
          s,
          editable ? (
            <button
              type="button"
              className="score-edit"
              aria-label={`עריכת היתרה של ${str(s.name)}`}
              title="עריכת היתרה"
              onClick={() => setEditing(s.id)}
            >
              <strong className="score-number">{s.shown}</strong>
              <Pencil size={13} aria-hidden="true" />
            </button>
          ) : (
            <strong className="score-number">{s.shown}</strong>
          )
        )
      )
    );
  }
  for (const s of outside)
    body.push(
      <tr
        key={s.id}
        {...own(s)}
        className={`manager-row ${s.id === state.actor.soldierId ? "personal-row" : ""}`}
      >
        {manager && <td className="cell-select" />}
        <td className="cell-place">
          <span className="rank-number" aria-label="ללא דירוג">
            —
          </span>
        </td>
        {nameCell(s, <Badge>אחראי, לא משתתף</Badge>)}
        <td className="cell-population">{population(s.population)}</td>
        <td className="cell-rank">{str(s.rankName, "—")}</td>
        <td className="cell-score">
          <strong className="score-number">{s.shown}</strong>{" "}
          <small className="muted">מוקפאת</small>
        </td>
      </tr>
    );

  return (
    <>
      <Notice>
        {future
          ? manager
            ? "הנקודות כוללות את השיבוצים שטרם זוכו, גם בטיוטות, כמו בבחירת המועמדים."
            : "הנקודות כוללות את השיבוצים שטרם זוכו בתורנויות שפורסמו."
          : "הטבלה מציגה נקודות מביצועים שכבר הסתיימו. שיבוצים עתידיים נשמרים בנפרד ונכללים בבחירת המועמדים."}
        {managers.length > 0 &&
          " אחראי תורנויות אינו משובץ לתורנויות, ולכן אינו מדורג והיתרה שלו מוקפאת."}
      </Notice>
      <BandStrip state={state} ranked={ranked} />
      <Panel
        title="דירוג החיילים"
        subtitle={`${ranked.length} חיילים · ניקוד זהה מקבל דירוג משותף${
          managers.length ? ` · ${managers.length} אחראים מחוץ לדירוג` : ""
        }`}
        actions={
          manager && (
            <button
              type="button"
              className="btn secondary"
              onClick={() => setUnitLedger(true)}
            >
              <BookOpen size={16} aria-hidden="true" /> יומן היחידה
            </button>
          )
        }
      >
        {/* One ruled line of controls over the table (decision 242). */}
        <div className="ledger-toolbar">
          <label className="search">
            <Search size={17} />
            <input
              aria-label="חיפוש חייל"
              placeholder="חיפוש לפי שם…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <select
            aria-label="סינון אוכלוסייה"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <option value="">כל האוכלוסיות</option>
            {populations.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
          {manager && (
            <HeldFilters state={state} value={held} onChange={setHeld} />
          )}
          <label className="toggle">
            <input
              type="checkbox"
              role="switch"
              checked={future}
              onChange={(e) => {
                setFuture(e.target.checked);
                setEditing(null);
              }}
            />
            כולל ניקוד עתידי
          </label>
        </div>
        {filtered.length || outside.length ? (
          <div className="table-scroll" {...scrollRegion("טבלת הצדק")}>
            <table className={`fairness-table ${manager ? "selectable" : ""}`}>
              <thead>
                <tr>
                  {manager && (
                    <th className="cell-select">
                      <input
                        type="checkbox"
                        aria-label="בחירת כל המוצגים"
                        checked={allChosen}
                        onChange={() =>
                          setSelected(
                            allChosen
                              ? new Set()
                              : new Set(filtered.map((s) => s.id))
                          )
                        }
                      />
                    </th>
                  )}
                  {head("דירוג", "rank", "cell-place")}
                  {head("שם החייל", "name", "cell-name")}
                  {head("אוכלוסייה", "population", "cell-population")}
                  {head("דרגה", "rankName", "cell-rank")}
                  {head(
                    future ? "נקודות כולל עתידי" : "נקודות",
                    "points",
                    "cell-score"
                  )}
                </tr>
              </thead>
              <tbody>{body}</tbody>
              {filtered.length > 0 && (
                <tfoot>
                  {/* The ledger's closing line: what the rows shown add up to. */}
                  <tr className="totals-row">
                    {manager && <td className="cell-select" />}
                    <td className="cell-place" />
                    <th scope="row" className="cell-name">
                      סה״כ {filtered.length} חיילים
                    </th>
                    <td className="cell-population" />
                    <td className="cell-rank">
                      ממוצע{" "}
                      {(
                        filtered.reduce((sum, s) => sum + s.shown, 0) /
                        filtered.length
                      ).toFixed(1)}
                    </td>
                    <td className="cell-score">
                      <strong className="score-total">
                        {filtered.reduce((sum, s) => sum + s.shown, 0)}
                      </strong>
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        ) : (
          <Empty
            title="לא נמצאו חיילים"
            text="אפשר לשנות את הסינון או את החיפוש."
          />
        )}
      </Panel>
      {manager && chosen.length > 0 && (
        <div
          className="selection-bar"
          role="region"
          aria-label="פעולה על הנבחרים"
        >
          <strong>{chosen.length} נבחרו</strong>
          <button
            type="button"
            className="text-button"
            onClick={() => setSelected(new Set())}
          >
            ניקוי
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={() => setBulk(true)}
          >
            שינוי יתרה…
          </button>
        </div>
      )}
      {bulk && (
        <Modal
          title={`שינוי יתרה · ${chosen.length} חיילים`}
          onClose={() => setBulk(false)}
        >
          <p className="form-description">
            {chosen.map((s) => str(s.name)).join(", ")}
          </p>
          <ScoreChange
            state={state}
            action={action}
            soldierIds={chosen.map((s) => s.id)}
            onDone={() => {
              setBulk(false);
              setSelected(new Set());
            }}
          />
        </Modal>
      )}
      {openedRow && (
        <Modal
          side
          title={`ניקוד · ${str(openedRow.name)}`}
          onClose={() => setOpened(null)}
        >
          <SoldierScore
            state={state}
            action={action}
            soldier={openedRow}
            onDone={() => setOpened(null)}
          />
        </Modal>
      )}
      {unitLedger && (
        <Modal
          side
          wide
          title="יומן הניקוד של היחידה"
          onClose={() => setUnitLedger(false)}
        >
          <UnitLedger state={state} />
        </Modal>
      )}
    </>
  );
}
