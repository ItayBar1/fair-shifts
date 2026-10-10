"use client";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  BookOpen,
  Pencil,
  Search,
} from "lucide-react";
import {
  type Action,
  type AppState,
  type Row,
  displayDate,
  num,
  personName,
  population,
  rows,
  str,
} from "@/client/types";
import {
  type FairnessColumn,
  type FairnessRow,
  type LedgerColumn,
  type LedgerFilter,
  type Sort,
  fairnessTable,
  ledgerKind,
  ledgerKinds,
  ledgerView,
  nextSort,
  noLedgerFilter,
  shownScore,
  sortFairness,
} from "@/client/fairness";
import { effectiveDiffers } from "@/domain/time";
import { AuditLink, ledgerSource } from "./audit";
import { Badge, Empty, Modal, Notice, Panel, populations } from "./ui";

/** A column head that sorts its column, telling assistive technology how. */
function SortHead<K extends string>({
  label,
  column,
  sort,
  onSort,
  className,
}: {
  label: string;
  column: K;
  sort: Sort<K>;
  onSort: (column: K) => void;
  className?: string;
}) {
  const active = sort.key === column;
  const Icon = !active
    ? ArrowUpDown
    : sort.direction === "asc"
      ? ArrowUp
      : ArrowDown;
  return (
    <th
      className={className}
      aria-sort={
        active
          ? sort.direction === "asc"
            ? "ascending"
            : "descending"
          : undefined
      }
    >
      <button
        type="button"
        className={`sort-head ${active ? "active" : ""}`}
        onClick={() => onSort(column)}
      >
        {label}
        <Icon size={13} aria-hidden="true" />
      </button>
    </th>
  );
}

type Preview = { rows: Row[]; token: string };
type ScoreInput = {
  soldierIds: string[];
  operation: string;
  value: number;
  reason: string;
};

const operations = [
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
function ScoreChange({
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
function EditingRow({
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
function LedgerTable({
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
    <div className="table-scroll">
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
function UnitLedger({ state }: { state: AppState }) {
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
function SoldierScore({
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
    str(s.name).includes(search) && (!filter || s.population === filter);
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
      <Panel
        title="טבלת הצדק היחידתית"
        subtitle={`${ranked.length} חיילים · ניקוד זהה מקבל דירוג משותף${
          managers.length ? ` · ${managers.length} אחראים מחוץ לדירוג` : ""
        }`}
        actions={
          <div className="toolbar-controls">
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
            {manager && (
              <button
                type="button"
                className="btn secondary"
                onClick={() => setUnitLedger(true)}
              >
                <BookOpen size={16} aria-hidden="true" /> יומן היחידה
              </button>
            )}
          </div>
        }
      >
        {filtered.length || outside.length ? (
          <div className="table-scroll">
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
