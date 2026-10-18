import { type AppState, type Row, rows } from "./types";

/**
 * A soldier's lists start 90 days back; earlier slices are read on request
 * (decision 235). The state reloads every 30 seconds, so slices already read
 * are kept apart, read again with each fresh state and laid under it, the
 * fresh copy winning.
 */
export type HistorySlice = {
  from: string;
  olderAvailable: boolean;
  duties: Row[];
  assignments: Row[];
  requests: Row[];
  notifications: Row[];
  ledger: Row[];
};
const listKeys = [
  "duties",
  "assignments",
  "requests",
  "notifications",
  "ledger",
] as const;

export type HistoryWindow = { from: string; olderAvailable: boolean };
export const historyOf = (state: AppState): HistoryWindow | undefined => {
  const value = state.history as HistoryWindow | undefined;
  return value && typeof value.from === "string" ? value : undefined;
};

/** The state with the earlier slices merged in; nothing changes without them. */
export function withHistory(state: AppState, slices: HistorySlice[]): AppState {
  if (!slices.length) return state;
  const merged: AppState = { ...state };
  for (const key of listKeys) {
    const current = rows(state[key]);
    const seen = new Set(current.map((row) => String(row.id)));
    const older = slices
      .flatMap((slice) => slice[key])
      .filter((row) => {
        const id = String(row.id);
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
    merged[key] = [...current, ...older];
  }
  const last = slices[slices.length - 1]!;
  merged.history = { from: last.from, olderAvailable: last.olderAvailable };
  return merged;
}

/**
 * Reads again the `count` slices before a fresh state's window. A row changed
 * since (a notice read or hidden, a request answered) then never comes back
 * from a stale slice, and rows that left the window meanwhile fall into the
 * first one.
 */
export async function refreshOlder(
  state: AppState,
  count: number
): Promise<HistorySlice[]> {
  const slices: HistorySlice[] = [];
  let before = historyOf(state)?.from;
  while (before && slices.length < count) {
    const slice = await fetchOlder(before);
    slices.push(slice);
    before = slice.olderAvailable ? slice.from : undefined;
  }
  return slices;
}

/** Reads the slice before `before`; throws with the server's message. */
export async function fetchOlder(before: string): Promise<HistorySlice> {
  const response = await fetch(
    `/api/v1/state/history?before=${encodeURIComponent(before)}`,
    { cache: "no-store", credentials: "same-origin" }
  );
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      typeof data?.error?.message === "string"
        ? data.error.message
        : "לא ניתן לטעון היסטוריה קודמת כרגע."
    );
  return data as HistorySlice;
}
