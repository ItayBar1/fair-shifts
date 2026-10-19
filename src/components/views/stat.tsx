"use client";
import { CalendarDays } from "lucide-react";

/**
 * One figure of a ruled summary line (decision 241): a label, the number in
 * ink and what it counts. No icon tile; a figure that filters is a button.
 */
export function Stat({
  label,
  value,
  detail,
  onClick,
  active,
  accessibleLabel,
}: {
  label: string;
  value: React.ReactNode;
  detail: string;
  /** Kept for callers; the ledger line draws no icon. */
  icon?: typeof CalendarDays;
  tone?: string;
  onClick?: () => void;
  active?: boolean;
  accessibleLabel?: string;
}) {
  const content = (
    <>
      <span className="stat-top">
        <span>{label}</span>
      </span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </>
  );
  return onClick ? (
    <button
      type="button"
      className={`stat stat-button ${active ? "active" : ""}`}
      aria-label={accessibleLabel ?? label}
      aria-pressed={active}
      onClick={onClick}
    >
      {content}
    </button>
  ) : (
    <div className="stat">{content}</div>
  );
}
