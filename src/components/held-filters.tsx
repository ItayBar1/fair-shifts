"use client";
import { type AppState, rows, str } from "@/client/types";
import type { HeldFilter } from "@/client/soldier-filters";

/**
 * Filters a list of soldiers by a capability or an exemption from the catalog,
 * valid on a chosen day (decision 224). The day appears once a filter is set.
 */
export function HeldFilters({
  state,
  value,
  onChange,
}: {
  state: AppState;
  value: HeldFilter;
  onChange: (value: HeldFilter) => void;
}) {
  const options = (kind: string) =>
    rows(state.eligibilityCatalog)
      .filter((item) => item.kind === kind)
      .map((item) => ({ value: item.id, label: str(item.name) }))
      .sort((a, b) => a.label.localeCompare(b.label, "he"));
  const capabilities = options("capability");
  const exemptions = options("exemption");
  const set = (part: Partial<HeldFilter>) => onChange({ ...value, ...part });
  return (
    <>
      {capabilities.length > 0 && (
        <select
          aria-label="סינון לפי כשירות"
          value={value.capability}
          onChange={(e) => set({ capability: e.target.value })}
        >
          <option value="">בלי סינון כשירות</option>
          {capabilities.map((item) => (
            <option key={item.value} value={item.value}>
              כשירות: {item.label}
            </option>
          ))}
        </select>
      )}
      {exemptions.length > 0 && (
        <select
          aria-label="סינון לפי פטור"
          value={value.exemption}
          onChange={(e) => set({ exemption: e.target.value })}
        >
          <option value="">בלי סינון פטור</option>
          {exemptions.map((item) => (
            <option key={item.value} value={item.value}>
              פטור: {item.label}
            </option>
          ))}
        </select>
      )}
      {(value.capability || value.exemption) && (
        <label className="date-filter">
          <span>בתוקף בתאריך</span>
          <input
            type="date"
            dir="ltr"
            aria-label="בתוקף בתאריך"
            title="ריק = בכל תאריך"
            value={value.date}
            onChange={(e) => set({ date: e.target.value })}
          />
        </label>
      )}
    </>
  );
}
