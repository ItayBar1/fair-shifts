import { type Row, num, str } from "./types";

export type FairnessRow = Row & { rank: number; shown: number };

/**
 * The points a row shows. Off, the current balance alone, as the shared table
 * has always shown it. On, the balance plus the points held by seats not yet
 * credited: for a manager the scheduling score, drafts included; for a soldier
 * only seats on published duties, since a draft never reaches them (decision 220).
 */
export const shownScore = (row: Row, future = false) =>
  num(row.currentScore ?? row.score) + (future ? num(row.futureScore) : 0);

/**
 * The shared fairness table. Equal points share a rank. A duty manager takes
 * no part in duties, so a manager holds no place in the ranking: managers come
 * after it, with their frozen balance (decision 192). Only a manager's state
 * marks managers; a soldier's state has none to mark.
 */
export function fairnessTable(soldiers: Row[], future = false) {
  const live = soldiers.filter((row) => !row.deletedAt);
  const byName = (a: Row, b: Row) =>
    str(a.name).localeCompare(str(b.name), "he");
  const score = (row: Row) => shownScore(row, future);
  const sorted = live
    .filter((row) => !row.isManager)
    .sort((a, b) => score(a) - score(b) || byName(a, b));
  const ranked: FairnessRow[] = sorted.map((row) => ({
    ...row,
    shown: score(row),
    rank: sorted.findIndex((other) => score(other) === score(row)) + 1,
  }));
  const managers = live
    .filter((row) => row.isManager)
    .sort(byName)
    .map((row): Row & { shown: number } => ({ ...row, shown: score(row) }));
  return { ranked, managers };
}

export type SortDirection = "asc" | "desc";
export type Sort<K extends string> = { key: K; direction: SortDirection };

/** A click on the sorted column turns it around; a click on another starts ascending. */
export function nextSort<K extends string>(sort: Sort<K>, key: K): Sort<K> {
  return sort.key === key
    ? { key, direction: sort.direction === "asc" ? "desc" : "asc" }
    : { key, direction: "asc" };
}

/**
 * Orders rows by one column, as a spreadsheet does: numbers by value, text by
 * Hebrew collation, empty values last whichever way. Ties keep their order.
 */
export function sortRows<T>(
  items: T[],
  value: (item: T) => string | number | undefined,
  direction: SortDirection
) {
  const sign = direction === "asc" ? 1 : -1;
  return items
    .map((item, index) => ({ item, index, key: value(item) }))
    .sort((a, b) => {
      const empty = (key: unknown) => key === undefined || key === "";
      if (empty(a.key) !== empty(b.key)) return empty(a.key) ? 1 : -1;
      const order =
        typeof a.key === "number" && typeof b.key === "number"
          ? a.key - b.key
          : str(a.key).localeCompare(str(b.key), "he", { numeric: true });
      return order * sign || a.index - b.index;
    })
    .map((entry) => entry.item);
}

export type FairnessColumn =
  "rank" | "name" | "population" | "rankName" | "points";

const populationOrder = ["mandatory", "career", "academic"];

/** The ranked rows in the order the viewer chose; the managers stay after them. */
export function sortFairness(rows: FairnessRow[], sort: Sort<FairnessColumn>) {
  const value = (row: FairnessRow) =>
    // The place follows the points, so both columns sort alike.
    sort.key === "rank" || sort.key === "points"
      ? row.shown
      : sort.key === "name"
        ? str(row.name)
        : sort.key === "population"
          ? populationOrder.indexOf(str(row.population))
          : str(row.rankName) || undefined;
  return sortRows(rows, value, sort.direction);
}

/** What each kind of score-ledger entry is, in the words of the screen. */
export const ledgerKinds: Record<string, string> = {
  opening: "יתרת פתיחה",
  import_set: "עדכון בייבוא",
  import_restore: "שחזור ייבוא",
  performance: "זיכוי ביצוע",
  correction: "תיקון ביצוע",
  correction_decision: "הכרעה בתיקון ביצוע",
  adjustment: "שינוי יתרה",
  normalization: "נרמול קבוצתי",
};
export const ledgerKind = (row: Row) =>
  ledgerKinds[str(row.kind)] ?? "שינוי ניקוד";

export type LedgerColumn =
  | "soldier"
  | "kind"
  | "effectiveAt"
  | "recordedAt"
  | "amount"
  | "after"
  | "reason";

export type LedgerFilter = {
  /** Words in the soldier's name or in the reason. */
  text: string;
  kind: string;
  /** Inclusive dates of the effective time, as yyyy-mm-dd; empty for no bound. */
  from: string;
  to: string;
};
export const noLedgerFilter: LedgerFilter = {
  text: "",
  kind: "",
  from: "",
  to: "",
};

/**
 * The score ledger filtered and ordered like a spreadsheet. The ledger is the
 * balance's history: it is read here, never edited (a change is a new entry).
 * Dates compare by the Israel calendar day of the effective time.
 */
export function ledgerView(
  ledger: Row[],
  nameOf: (id: unknown) => string,
  filter: LedgerFilter,
  sort: Sort<LedgerColumn>
) {
  const day = (value: unknown) =>
    str(value)
      ? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(
          new Date(str(value))
        )
      : "";
  const words = filter.text.trim();
  const shown = ledger.filter(
    (row) =>
      (!words ||
        nameOf(row.soldierId).includes(words) ||
        str(row.reason).includes(words)) &&
      (!filter.kind || ledgerKind(row) === filter.kind) &&
      (!filter.from || day(row.effectiveAt) >= filter.from) &&
      (!filter.to || day(row.effectiveAt) <= filter.to)
  );
  const value = (row: Row): string | number | undefined => {
    switch (sort.key) {
      case "soldier":
        return nameOf(row.soldierId);
      case "kind":
        return ledgerKind(row);
      case "effectiveAt":
      case "recordedAt":
        return Date.parse(str(row[sort.key])) || undefined;
      case "amount":
      case "after":
        return num(row[sort.key]);
      case "reason":
        return str(row.reason) || undefined;
    }
  };
  return sortRows(shown, value, sort.direction);
}
