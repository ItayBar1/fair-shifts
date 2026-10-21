"use client";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { type Sort } from "@/client/fairness";

/** A column head that sorts its column, telling assistive technology how. */
export function SortHead<K extends string>({
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
