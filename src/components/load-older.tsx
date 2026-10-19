"use client";
import { createContext, useContext } from "react";
import { displayDate } from "@/client/types";
import { Notice } from "./ui";

/** The soldier's history window and the way to read an earlier slice (decision 235). */
export type OlderHistory = {
  from: string;
  olderAvailable: boolean;
  loading: boolean;
  error: string;
  loadOlder: () => void;
};
export const OlderHistoryContext = createContext<OlderHistory | undefined>(
  undefined
);
export const useOlderHistory = () => useContext(OlderHistoryContext);

/**
 * "Load more" under a list that shows a soldier's last 90 days. A manager
 * already has everything, so nothing shows for one.
 */
export function LoadOlder({ what }: { what: string }) {
  const history = useOlderHistory();
  if (!history) return null;
  return (
    <div className="load-older" aria-live="polite">
      <p className="muted">
        {`מוצגים ${what} מ־${displayDate(history.from)} ואילך.`}
        {!history.olderAvailable && " אין מידע קודם."}
      </p>
      {history.olderAvailable && (
        <button
          type="button"
          className="btn"
          onClick={history.loadOlder}
          disabled={history.loading}
          aria-busy={history.loading}
        >
          {history.loading ? "טוענים…" : "טען עוד"}
        </button>
      )}
      {history.error && <Notice tone="danger">{history.error}</Notice>}
    </div>
  );
}
