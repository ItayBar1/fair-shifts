"use client";
import { useId, useMemo, useRef, useState } from "react";
import { ChevronDown, Search, SlidersHorizontal } from "lucide-react";
import {
  type AppState,
  assignableSoldiers,
  personName,
  rows,
  str,
} from "@/client/types";
import {
  NO_RANK,
  activeGroups,
  clearedFilters,
  defaultFilters,
  filterGroups,
  pickerOptions,
  pickerResults,
  rankIdAtStart,
  sameFilters,
  type FilterGroup,
  type PickerFilters,
  type PickerOption,
} from "@/client/soldier-picker";
import type { InstantRange, Requirements } from "@/domain/types";
import { ConditionToggles, genders } from "./eligibility-conditions";
import { Badge, populations } from "./ui";

const words = {
  duty: {
    all: "לכל משך התורנות",
    at: "במועד התורנות",
    start: "בתחילת התורנות",
  },
  period: {
    all: "לכל משך התקופה",
    at: "במועד התקופה",
    start: "בתחילת התקופה",
  },
};

const groupTitles = (
  scope: keyof typeof words
): Record<FilterGroup, string> => ({
  populations: `אוכלוסיית שיבוץ ${words[scope].all}`,
  genders: "מגדר",
  exemptions: `הסתרת מי שיש לו פטור ${words[scope].at}`,
  qualifications: `כשירות בתוקף ${words[scope].all}`,
  capabilities: "יכולת",
  ranks: `דרגה ${words[scope].start}`,
});

/**
 * One way to pick a soldier for a seat, wherever a manager does it (decision 193):
 * search by name or personal number as you type, and filters by population, gender,
 * exemption, qualification, capability and rank. The filters open already filled in
 * from the duty and the role, and every one can be cleared. They only help find
 * someone; the server still checks eligibility after the choice.
 *
 * Inside a form, give it a `name` and it submits the choice like any field.
 * `compact` shows only the current choice and opens the finder on demand.
 */
export function SoldierPicker({
  state,
  label,
  name,
  value: controlled,
  defaultValue,
  onChange,
  range,
  requirements,
  scope = "duty",
  keep = [],
  keepDeleted = [],
  emptyOption,
  required,
  compact,
}: {
  state: AppState;
  label: string;
  name?: string;
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  /** The duty, or the execution period, the soldier would cover. */
  range: InstantRange;
  /** The duty's and the role's conditions, which fill the filters in. */
  requirements: Requirements[];
  scope?: keyof typeof words;
  /** Managers who may still be listed because they hold the place now. */
  keep?: unknown[];
  /** A soldier deleted while the duty ran who is still recorded in the seat (decision 196). */
  keepDeleted?: unknown[];
  /** A choice that is not a soldier, such as leaving the place vacant. */
  emptyOption?: PickerOption;
  /** Needs the choices on screen, so use it with the picker that is not `compact`. */
  required?: boolean;
  compact?: boolean;
}) {
  const id = useId();
  const labelId = `${id}-label`;
  const panelId = `${id}-panel`;
  const filtersId = `${id}-filters`;
  const statusId = `${id}-status`;
  const toggle = useRef<HTMLButtonElement>(null);
  const [inner, setInner] = useState(defaultValue ?? "");
  const value = controlled ?? inner;
  const rankCatalog = rows(state.rankCatalog);
  const defaults = defaultFilters(requirements, rankCatalog);
  const [filters, setFilters] = useState<PickerFilters>(defaults);
  const [open, setOpen] = useState(!compact);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const keepKey = keep.map(String).join(",");
  const keepDeletedKey = keepDeleted.map(String).join(",");
  const candidates = useMemo(
    () =>
      assignableSoldiers(
        state,
        keepKey ? keepKey.split(",") : [],
        keepDeletedKey ? keepDeletedKey.split(",") : []
      ),
    [state, keepKey, keepDeletedKey]
  );
  const { start, end } = range;
  const results = useMemo(
    () => pickerResults(candidates, filters, { start, end }, value),
    [candidates, filters, start, end, value]
  );
  const options = pickerOptions(state);
  const tracks = options.ranks.length > 1;
  const choices: Record<FilterGroup, PickerOption[]> = {
    populations,
    genders,
    exemptions: options.exemptions,
    qualifications: options.qualifications,
    capabilities: options.capabilities,
    ranks: options.ranks.length
      ? [
          ...options.ranks.flatMap(({ track, ranks }) =>
            ranks.map((rank) => ({
              value: rank.value,
              label: tracks ? `${rank.label} · מסלול ${track}` : rank.label,
            }))
          ),
          { value: NO_RANK, label: "ללא דרגה" },
        ]
      : [],
  };
  const titles = groupTitles(scope);
  const rankNames = new Map(
    rankCatalog.map((rank) => [rank.id, str(rank.name)])
  );

  const active = activeGroups(filters);
  const searching = filters.search.trim() !== "";
  const total = candidates.length;
  const status = !total
    ? "אין חיילים לבחירה"
    : !searching && !active.length
      ? `${total} חיילים`
      : results.length
        ? `${results.length} מתוך ${total} חיילים`
        : "אין חיילים שמתאימים לחיפוש ולסינון";
  const summary = active
    .map((group) => {
      const names = filters[group].map(
        (item) =>
          choices[group].find((option) => option.value === item)?.label ?? item
      );
      return `${titles[group]}: ${names.join(", ")}`;
    })
    .join(" · ");

  const choose = (next: string) => {
    setInner(next);
    onChange?.(next);
    if (compact) {
      setOpen(false);
      toggle.current?.focus();
    }
  };
  const number = (soldierId: string) => {
    const row = candidates.find((item) => item.id === soldierId);
    return row ? ` · ${str(row.personalNumber)}` : "";
  };
  const current =
    emptyOption && value === emptyOption.value
      ? emptyOption.label
      : value
        ? `${personName(state, value)}${number(value)}`
        : "לא נבחר חייל";
  const setGroup = (group: FilterGroup, next: string[]) =>
    setFilters((now) => ({ ...now, [group]: next }));

  return (
    <div className="soldier-picker">
      {name && <input type="hidden" name={name} value={value} />}
      <div className="picker-head">
        <span id={labelId} className="picker-label">
          {label}
          {required && (
            <span aria-hidden="true" className="required">
              {" "}
              *
            </span>
          )}
        </span>
        {compact && (
          <button
            type="button"
            ref={toggle}
            className="btn secondary picker-current"
            aria-expanded={open}
            aria-controls={panelId}
            aria-label={`${label}: ${current}`}
            onClick={() => setOpen(!open)}
          >
            <span>{current}</span>
            <ChevronDown size={15} aria-hidden="true" />
          </button>
        )}
      </div>
      {open && (
        <div
          id={panelId}
          className="picker-panel"
          role={compact ? "group" : undefined}
          aria-labelledby={compact ? labelId : undefined}
          onKeyDown={(event) => {
            if (!compact || event.key !== "Escape") return;
            // Closes the finder, not the dialog around it.
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
            toggle.current?.focus();
          }}
        >
          <div className="picker-tools">
            <label className="search">
              <Search size={17} aria-hidden="true" />
              <input
                type="search"
                autoComplete="off"
                aria-label={`חיפוש חייל לפי שם או מספר אישי — ${label}`}
                placeholder="שם או מספר אישי…"
                value={filters.search}
                onChange={(event) =>
                  setFilters((now) => ({ ...now, search: event.target.value }))
                }
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  // Enter picks the one person left, and never submits the form around it.
                  event.preventDefault();
                  if (results.length === 1) choose(results[0].id);
                }}
              />
            </label>
            <button
              type="button"
              className="btn small secondary"
              aria-expanded={filtersOpen}
              aria-controls={filtersId}
              onClick={() => setFiltersOpen(!filtersOpen)}
            >
              <SlidersHorizontal size={15} aria-hidden="true" />
              {active.length ? `סינון (${active.length})` : "סינון"}
            </button>
            {compact && (
              <button
                type="button"
                className="btn small secondary"
                onClick={() => {
                  setOpen(false);
                  toggle.current?.focus();
                }}
              >
                סגירה
              </button>
            )}
          </div>
          {!filtersOpen && summary && (
            <p className="muted picker-summary">מסונן לפי: {summary}</p>
          )}
          {filtersOpen && (
            <div id={filtersId} className="picker-filters">
              {filterGroups.map(
                (group) =>
                  choices[group].length > 0 && (
                    <ConditionToggles
                      key={group}
                      legend={titles[group]}
                      options={choices[group]}
                      value={filters[group]}
                      onChange={(next) => setGroup(group, next)}
                    />
                  )
              )}
              <div className="picker-tools">
                {active.length > 0 && (
                  <button
                    type="button"
                    className="btn small secondary"
                    onClick={() => setFilters(clearedFilters(filters))}
                  >
                    ניקוי הסינונים
                  </button>
                )}
                {!sameFilters(filters, defaults) && (
                  <button
                    type="button"
                    className="btn small secondary"
                    onClick={() =>
                      setFilters((now) => ({ ...defaults, search: now.search }))
                    }
                  >
                    חזרה לברירת המחדל של התורנות
                  </button>
                )}
              </div>
            </div>
          )}
          <p id={statusId} role="status" className="muted picker-summary">
            {status}
          </p>
          <div
            role="radiogroup"
            aria-labelledby={labelId}
            aria-describedby={statusId}
            className="picker-list"
          >
            {emptyOption && (
              <label className="picker-option">
                <input
                  type="radio"
                  name={`${id}-choice`}
                  value={emptyOption.value}
                  checked={value === emptyOption.value}
                  required={required}
                  onChange={() => choose(emptyOption.value)}
                />
                <span>{emptyOption.label}</span>
              </label>
            )}
            {results.map((row) => {
              const rank = rankNames.get(rankIdAtStart(row, range) ?? "");
              return (
                <label className="picker-option" key={row.id}>
                  <input
                    type="radio"
                    name={`${id}-choice`}
                    value={row.id}
                    checked={value === row.id}
                    required={required}
                    onChange={() => choose(row.id)}
                  />
                  <strong>{str(row.name)}</strong>
                  <bdi dir="ltr" className="muted picker-number">
                    {str(row.personalNumber)}
                  </bdi>
                  {rank && <span className="muted">{rank}</span>}
                  {row.isManager === true && (
                    <Badge tone="warning">אחראי, יש להחליף</Badge>
                  )}
                  {Boolean(row.deletedAt) && <Badge tone="danger">נמחק</Badge>}
                </label>
              );
            })}
          </div>
          {(searching || active.length > 0) && !results.length && (
            <p className="muted picker-summary">
              אפשר לשנות את החיפוש או לנקות את הסינונים.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
