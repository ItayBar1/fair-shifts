"use client";
import { useState } from "react";
import { Send } from "lucide-react";
import { Fields, Notice } from "./ui";

/**
 * The public contact form (decision 228). The site stores the request and the
 * technical account gets one digest mail a day; nothing is sent right away.
 */
export function ContactForm() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  if (sent)
    return (
      <Notice>
        הפנייה התקבלה. המנהל הטכני יקבל אותה במייל המרוכז היומי ויחזור אליך
        בפרטי הקשר שמסרת.
      </Notice>
    );
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        const form = new FormData(e.currentTarget);
        setError("");
        setPending(true);
        try {
          const response = await fetch("/api/contact", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: String(form.get("name") || ""),
              contact: String(form.get("contact") || ""),
              message: String(form.get("message") || ""),
              website: String(form.get("website") || ""),
            }),
          });
          if (!response.ok) {
            const data = await response.json().catch(() => null);
            throw new Error(
              data?.error?.code === "invalid_input"
                ? "יש למלא שם, פרטי קשר לחזרה ואת הפנייה"
                : (data?.error?.message ?? "השליחה לא הושלמה. אפשר לנסות שוב.")
            );
          }
          setSent(true);
        } catch (error) {
          setError(
            error instanceof Error
              ? error.message
              : "השליחה לא הושלמה. אפשר לנסות שוב."
          );
        } finally {
          setPending(false);
        }
      }}
    >
      <fieldset disabled={pending}>
        <Fields
          fields={[
            { name: "name", label: "שם", required: true },
            {
              name: "contact",
              label: "מייל או טלפון לחזרה",
              required: true,
            },
            {
              name: "message",
              label: "הפנייה",
              type: "textarea",
              required: true,
              full: true,
            },
          ]}
        />
        {/* Left empty by people; a bot that fills it is accepted quietly and dropped. */}
        <input
          className="visually-hidden"
          name="website"
          tabIndex={-1}
          autoComplete="off"
          aria-hidden="true"
        />
        {error && <Notice tone="danger">{error}</Notice>}
        <div className="form-actions">
          <button className="btn primary" type="submit" aria-busy={pending}>
            {pending ? <span className="spinner small" /> : <Send size={17} />}{" "}
            {pending ? "שולחים…" : "שליחת הפנייה"}
          </button>
        </div>
      </fieldset>
    </form>
  );
}
