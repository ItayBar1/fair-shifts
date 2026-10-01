"use client";
import { useState } from "react";
import Link from "next/link";
import {
  type Action,
  type Row,
  displayDate,
  num,
  obj,
  rows,
  str,
} from "@/client/types";
import { Badge, Form, Modal, Notice } from "./ui";

function Seats({
  title,
  seats,
  tone,
}: {
  title: string;
  seats: Row[];
  tone: string;
}) {
  if (!seats.length) return null;
  return (
    <section className="subsection" aria-label={title}>
      <h4>
        {title} <Badge tone={tone}>{seats.length}</Badge>
      </h4>
      {seats.map((seat) => (
        <p key={str(seat.assignmentId)}>
          <Link className="text-link" href={`/duties/${str(seat.dutyId)}`}>
            {str(seat.dutyName)}
          </Link>{" "}
          · {str(seat.role)} · {displayDate(seat.start, true)}
          {seat.end ? <> — {displayDate(seat.end, true)}</> : null}
        </p>
      ))}
    </section>
  );
}

/**
 * Deleting a user (decision 192). The manager first sees what the deletion
 * would vacate, flag and remove; only then does the save, bound to that view,
 * become possible.
 */
export function SoldierDeletion({
  person,
  action,
  onDone,
  self = false,
}: {
  person: Row;
  action: Action;
  onDone: () => void;
  /** A manager cannot delete their own record. */
  self?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  async function begin() {
    setOpen(true);
    setPreview(null);
    setError("");
    setLoading(true);
    try {
      setPreview(
        await action(
          "soldier.delete.preview",
          { id: person.id },
          person.version
        )
      );
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "לא ניתן לבדוק את ההשפעה"
      );
    } finally {
      setLoading(false);
    }
  }
  const close = () => setOpen(false);
  const removes = obj(preview?.removes);
  return (
    <>
      <button
        className="btn danger"
        disabled={self}
        title={self ? "אי אפשר למחוק את הרשומה שלך" : undefined}
        onClick={begin}
      >
        מחיקת המשתמש והמידע הרגיש
      </button>
      {open && (
        <Modal title={`מחיקת משתמש · ${str(person.name)}`} onClose={close} wide>
          {loading && <p role="status">בודקים מה תשפיע המחיקה…</p>}
          {error && <Notice tone="danger">{error}</Notice>}
          {preview && (
            <>
              <Notice tone="warning">
                המחיקה מיידית ואין שחזור אוטומטי של המידע שיוסר. נעילה, שחרור
                ואי־פעילות אינם מחיקה.
              </Notice>
              <div className="two-columns">
                <section aria-label="מה נשמר">
                  <h3>נשמר</h3>
                  <ul>
                    <li>שם ומספר אישי</li>
                    <li>היסטוריית התורנויות והניקוד</li>
                    <li>דרגה, אוכלוסייה ותאריכי שירות</li>
                    <li>אירוע המחיקה וסיבתה ביומן הפעולות</li>
                  </ul>
                </section>
                <section aria-label="מה יוסר">
                  <h3>יוסר</h3>
                  <ul>
                    <li>פרטי קשר: מייל, טלפון וכתובת</li>
                    <li>
                      פטורים, כשירויות, אי־פעילות, מגדר, יכולות והגבלות שעות
                      {removes.conditions === true ? "" : " (אין רשומים)"}
                    </li>
                    <li>נימוקי אילוצים, בקשות והחלטות על אישור חריג</li>
                    <li>
                      גישה: חיבורים, קודי כניסה ושחזור, קישור Google ומיילים
                      שבתור
                    </li>
                  </ul>
                </section>
              </div>
              <Seats
                title="מקומות עתידיים שיתפנו"
                seats={rows(preview.vacated)}
                tone="warning"
              />
              <Seats
                title="שיבוצים בתורנות שכבר התחילה: נשארים ומסומנים לטיפול דחוף"
                seats={rows(preview.inProgress)}
                tone="danger"
              />
              {!rows(preview.vacated).length &&
                !rows(preview.inProgress).length && (
                  <p>אין לחייל שיבוצים פעילים.</p>
                )}
              {num(preview.openRequests) > 0 && (
                <p>
                  {num(preview.openRequests)} בקשות פתוחות להעברה, להחלפה או
                  לביטול ייסגרו.
                </p>
              )}
              <Form
                fields={[
                  {
                    name: "reason",
                    label: "סיבת המחיקה",
                    type: "textarea",
                    required: true,
                    full: true,
                    hint: "הסיבה נשמרת ביומן הפעולות גם אחרי המחיקה. אין לכתוב בה מידע רגיש.",
                  },
                  {
                    name: "confirmed",
                    label:
                      "בדקתי את ההשפעה. הבנתי שפרטי הקשר והמידע הרגיש יימחקו, מקומות עתידיים יתפנו וההיסטוריה הנדרשת תישמר",
                    type: "checkbox",
                    required: true,
                  },
                ]}
                submitLabel="מחיקת המשתמש"
                onSubmit={async (values) => {
                  await action(
                    "soldier.delete",
                    {
                      id: person.id,
                      previewToken: preview.previewToken,
                      reason: values.reason,
                      confirmed: values.confirmed,
                    },
                    person.version
                  );
                  close();
                  onDone();
                }}
                onCancel={close}
              />
            </>
          )}
        </Modal>
      )}
    </>
  );
}
