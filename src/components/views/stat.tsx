"use client";
import { CalendarDays } from "lucide-react";

export function Stat({
  label,
  value,
  detail,
  icon: Icon,
  tone = "teal",
  onClick,
  active,
  accessibleLabel,
}: {
  label: string;
  value: React.ReactNode;
  detail: string;
  icon: typeof CalendarDays;
  tone?: string;
  onClick?: () => void;
  active?: boolean;
  accessibleLabel?: string;
}) {
  const content = (
    <>
      <span className="stat-top">
        <span>{label}</span>
        <span className={`stat-icon ${tone}`}>
          <Icon size={20} />
        </span>
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
