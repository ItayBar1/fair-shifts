import { type Row, num, str } from "./types";

export type FairnessRow = Row & { rank: number };

const scoreOf = (row: Row) => num(row.currentScore ?? row.score);

/**
 * The shared fairness table. Equal balances share a rank. A duty manager takes
 * no part in duties, so a manager holds no place in the ranking: managers come
 * after it, with their frozen balance (decision 192). Only a manager's state
 * marks managers; a soldier's state has none to mark.
 */
export function fairnessTable(soldiers: Row[]) {
  const live = soldiers.filter((row) => !row.deletedAt);
  const byName = (a: Row, b: Row) =>
    str(a.name).localeCompare(str(b.name), "he");
  const sorted = live
    .filter((row) => !row.isManager)
    .sort((a, b) => scoreOf(a) - scoreOf(b) || byName(a, b));
  const ranked: FairnessRow[] = sorted.map((row) => ({
    ...row,
    rank: sorted.findIndex((other) => scoreOf(other) === scoreOf(row)) + 1,
  }));
  const managers = live.filter((row) => row.isManager).sort(byName);
  return { ranked, managers };
}
