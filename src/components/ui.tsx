"use client";
import { useId, useRef, useState, useEffect, type ReactNode } from "react";
import { X, Check, AlertCircle, Inbox, Plus, ChevronDown } from "lucide-react";
import { str, type Action } from "@/client/types";
export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
const statusLabels: Record<string, string> = {
  draft: "טיוטה",
  published: "פורסמה",
  cancelled: "בוטלה",
  completed: "הושלמה",
  pending: "ממתין",
  approved: "אושר",
  rejected: "נדחה",
  awaiting_consent: "ממתינה להסכמה",
  awaiting_manager: "ממתינה לאחראי",
  accepted: "התקבלה",
  reserved: "שמור",
  active: "פעיל",
  inactive: "לא פעיל",
  locked: "נעול",
  failed: "נכשל",
  sent: "נשלח",
  success: "הצליח",
  running: "בתהליך",
  needs_review: "דורש טיפול",
  transferred: "הועבר",
  waiting_manager: "ממתינה לאחראי",
  preview: "תצוגה מקדימה",
  applied: "נשמרה",
  restored: "שוחזרה",
  partially_restored: "שוחזרה חלקית",
  declared: "הוגש: אין אילוצים",
  upcoming: "טרם נפתח",
  open: "פתוח להגשה",
  closed: "נסגר",
};
export function Status({ value }: { value: unknown }) {
  const status = str(value, "pending");
  return (
    <Badge
      tone={
        [
          "published",
          "approved",
          "completed",
          "success",
          "sent",
          "active",
          "declared",
          "open",
        ].includes(status)
          ? "success"
          : ["failed", "cancelled", "locked"].includes(status)
            ? "danger"
            : ["draft", "pending", "awaiting_manager", "needs_review"].includes(
                  status
                )
              ? "warning"
              : "neutral"
      }
    >
      {statusLabels[status] || status}
    </Badge>
  );
}
export function Empty({
  title = "עדיין אין כאן פריטים",
  text,
  action,
}: {
  title?: string;
  text?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Inbox size={27} />
      </span>
      <h3>{title}</h3>
      {text && <p>{text}</p>}
      {action}
    </div>
  );
}
export function Notice({
  children,
  tone = "info",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return (
    <div
      className={`notice ${tone}`}
      role={tone === "danger" ? "alert" : "status"}
    >
      {tone === "success" ? <Check size={19} /> : <AlertCircle size={19} />}
      <div>{children}</div>
    </div>
  );
}
export function Panel({
  title,
  subtitle,
  actions,
  children,
  className = "",
}: {
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      {(title || actions) && (
        <div className="panel-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}
export function Modal({
  title,
  children,
  onClose,
  wide,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      className={`modal ${wide ? "wide" : ""}`}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-head">
        <h2 id={titleId}>{title}</h2>
        <button
          type="button"
          className="icon-btn"
          aria-label="סגירה"
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </div>
      <div className="modal-body">{children}</div>
    </dialog>
  );
}
export type Field = {
  name: string;
  label: string;
  type?:
    | "text"
    | "number"
    | "email"
    | "date"
    | "datetime-local"
    | "time"
    | "textarea"
    | "select"
    | "multiselect"
    | "checkbox"
    | "password";
  required?: boolean;
  options?: { value: string; label: string }[];
  value?: string | number | boolean | string[];
  hint?: string;
  min?: number;
  max?: number;
  step?: string;
  full?: boolean;
};
export function Fields({ fields }: { fields: Field[] }) {
  return (
    <div className="form-grid">
      {fields.map((field) => (
        <label
          className={`field ${field.full ? "full" : ""} ${field.type === "checkbox" ? "check-field" : ""}`}
          key={field.name}
        >
          {field.type === "checkbox" ? (
            <>
              <input
                aria-label={field.label}
                type="checkbox"
                name={field.name}
                defaultChecked={Boolean(field.value)}
                required={field.required}
              />
              <span>
                {field.label}
                {field.hint && <small>{field.hint}</small>}
              </span>
            </>
          ) : (
            <>
              <span>
                {field.label}
                {field.required && (
                  <span aria-hidden="true" className="required">
                    {" "}
                    *
                  </span>
                )}
              </span>
              {field.type === "select" || field.type === "multiselect" ? (
                <span className="select-wrap">
                  <select
                    aria-label={field.label}
                    name={field.name}
                    multiple={field.type === "multiselect"}
                    defaultValue={
                      field.type === "multiselect"
                        ? Array.isArray(field.value)
                          ? field.value
                          : []
                        : String(field.value ?? "")
                    }
                    required={field.required}
                  >
                    {field.type !== "multiselect" && !field.value && (
                      <option value="">בחירה…</option>
                    )}
                    {field.options?.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={15} />
                </span>
              ) : field.type === "textarea" ? (
                <textarea
                  aria-label={field.label}
                  name={field.name}
                  defaultValue={str(field.value)}
                  required={field.required}
                  rows={3}
                />
              ) : (
                <input
                  aria-label={field.label}
                  name={field.name}
                  type={field.type || "text"}
                  defaultValue={str(field.value)}
                  required={field.required}
                  min={field.min}
                  max={field.max}
                  step={field.step}
                  dir={
                    [
                      "number",
                      "email",
                      "date",
                      "datetime-local",
                      "time",
                    ].includes(field.type || "")
                      ? "ltr"
                      : undefined
                  }
                />
              )}
              {field.hint && <small>{field.hint}</small>}
            </>
          )}
        </label>
      ))}
    </div>
  );
}
export function Form({
  fields,
  onSubmit,
  submitLabel = "שמירה",
  children,
  onCancel,
}: {
  fields: Field[];
  onSubmit: (values: Record<string, unknown>) => Promise<unknown>;
  submitLabel?: string;
  children?: ReactNode;
  onCancel?: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        const form = new FormData(e.currentTarget);
        const values: Record<string, unknown> = {};
        for (const field of fields)
          values[field.name] =
            field.type === "checkbox"
              ? form.has(field.name)
              : field.type === "multiselect"
                ? form.getAll(field.name).map(String)
                : field.type === "number" && form.get(field.name) !== ""
                  ? Number(form.get(field.name))
                  : String(form.get(field.name) || "");
        setError("");
        setPending(true);
        try {
          await onSubmit(values);
        } catch (error) {
          setError(
            error instanceof Error
              ? error.message
              : "השמירה לא הושלמה. אפשר לנסות שוב."
          );
        } finally {
          setPending(false);
        }
      }}
    >
      <fieldset disabled={pending}>
        <Fields fields={fields} />
        {children}
        {error && <Notice tone="danger">{error}</Notice>}
        <div className="form-actions">
          <button className="btn primary" type="submit">
            {pending ? <span className="spinner small" /> : <Check size={17} />}{" "}
            {pending ? "שומרים…" : submitLabel}
          </button>
          {onCancel && (
            <button className="btn secondary" type="button" onClick={onCancel}>
              ביטול
            </button>
          )}
        </div>
      </fieldset>
    </form>
  );
}
export function ActionDialog({
  title,
  buttonLabel,
  fields,
  action,
  type,
  payload = {},
  version,
  transform,
  description,
  danger = false,
}: {
  title: string;
  buttonLabel?: string;
  fields: Field[];
  action: Action;
  type: string;
  payload?: Record<string, unknown>;
  version?: number;
  transform?: (v: Record<string, unknown>) => Record<string, unknown>;
  description?: string;
  danger?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className={`btn ${danger ? "danger" : "secondary"}`}
        onClick={() => setOpen(true)}
      >
        {buttonLabel || (
          <>
            <Plus size={17} />
            {title}
          </>
        )}
      </button>
      {open && (
        <Modal title={title} onClose={() => setOpen(false)}>
          {description && <p className="form-description">{description}</p>}
          <Form
            fields={fields}
            onSubmit={async (values) => {
              await action(
                type,
                { ...payload, ...(transform ? transform(values) : values) },
                version
              );
              setOpen(false);
            }}
            onCancel={() => setOpen(false)}
          />
        </Modal>
      )}
    </>
  );
}
export function QuickAction({
  children,
  type,
  payload,
  version,
  action,
  className = "secondary",
}: {
  children: ReactNode;
  type: string;
  payload: Record<string, unknown>;
  version?: number;
  action: Action;
  className?: string;
}) {
  const [pending, setPending] = useState(false);
  return (
    <button
      disabled={pending}
      className={`btn ${className}`}
      onClick={async () => {
        setPending(true);
        try {
          await action(type, payload, version);
        } catch {
          /* workspace displays API error */
        } finally {
          setPending(false);
        }
      }}
    >
      {pending ? "מעדכנים…" : children}
    </button>
  );
}
export const populations = [
  { value: "mandatory", label: "חובה" },
  { value: "career", label: "קבע / קצינים" },
  { value: "academic", label: "קמ״א" },
];
