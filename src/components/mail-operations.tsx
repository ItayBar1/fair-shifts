"use client";
import type { ReactNode } from "react";
import { displayDate, num, obj, rows, str } from "@/client/types";
import { Badge, Empty, Notice, Panel } from "./ui";

const statusLabels: Record<string, [string, string]> = {
  ok: ["תקין", "success"],
  attention: ["דורש טיפול", "danger"],
  disabled: ["כבוי", "neutral"],
};
export function MailBadge({ value }: { value: unknown }) {
  const [label, tone] = statusLabels[str(value)] ?? [
    str(value, "—"),
    "neutral",
  ];
  return <Badge tone={tone}>{label}</Badge>;
}
const kindLabels: Record<string, string> = {
  "login-code": "קוד כניסה",
  "email-change": "אימות כתובת מייל",
  invitation: "הזמנה",
  "duty-reminder": "תזכורת לפני תורנות",
  "round-opening": "פתיחת סבב אילוצים",
  "round-closing": "סגירת סבב אילוצים",
  publication: "פרסום שיבוץ",
  "publication-change": "שינוי או ביטול שפורסם",
  transfer: "החלפות ובקשות",
  departure: "סיום שירות",
  "backup-alert": "התראת גיבוי",
};
const errorLabels: Record<string, string> = {
  delivery_failed: "הספק לא קיבל את המייל גם אחרי ניסיונות חוזרים",
  rejected: "הספק דחה את המייל (למשל כתובת לא תקינה)",
  quota_exhausted: "המכסה היומית נגמרה לפני שהמייל נשלח בזמן",
};
const pauseLabels: Record<string, string> = {
  configuration:
    "הספק דחה את פרטי החשבון (מפתח API או כתובת שולח). המשלוח מושהה ויתחדש אוטומטית; יש לבדוק את הגדרות Brevo.",
  provider_quota:
    "הספק הודיע שהמכסה נגמרה. המשלוח מושהה עד היום הבא; אין שדרוג אוטומטי למסלול בתשלום.",
};
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="task-item">
      <strong className="grow">{label}</strong>
      <div className="inline">{children}</div>
    </div>
  );
}

/** Warnings shared by the dashboard row and the mail screen. */
function MailNotices({ mail }: { mail: Record<string, unknown> }) {
  const paused = obj(mail.paused);
  return (
    <>
      {paused.until !== undefined && (
        <Notice tone="danger">
          {pauseLabels[str(paused.reason)] ?? "המשלוח מושהה."} חידוש צפוי:{" "}
          {displayDate(paused.until, true)}.
        </Notice>
      )}
      {mail.quotaExhausted === true && (
        <Notice tone="warning">
          המכסה היומית להודעות נגמרה ({num(mail.limit) - num(mail.reserve)}{" "}
          הודעות, ועוד {num(mail.reserve)} שמורות לקודי כניסה ולאימות מייל).
          הודעות שעדיין רלוונטיות יישלחו כשהמכסה תתחדש; הודעות האתר נשארות בכל
          מקרה.
        </Notice>
      )}
    </>
  );
}

export function MailHealthRow({ mail }: { mail: Record<string, unknown> }) {
  return (
    <>
      <Row label="משלוח מייל">
        <MailBadge value={mail.status} />
        <span>
          היום {num(mail.used)} מתוך {num(mail.limit)}
        </span>
      </Row>
      {mail.status === "attention" && (
        <Notice tone="warning">
          יש כשל או מחסור במכסת המייל. הפרטים במסך ״משלוחי מייל״.
        </Notice>
      )}
    </>
  );
}

/** Operational view only: no recipients, addresses or message content. */
export function MailPanel({ mail }: { mail: Record<string, unknown> }) {
  const failures = rows(mail.failures);
  return (
    <>
      <Panel
        title="מכסה ותור"
        subtitle={`יום מכסה ${str(mail.day)} · ספק: ${
          mail.transport === "brevo" ? "Brevo" : "כבוי בסביבה זו"
        }`}
        actions={<MailBadge value={mail.status} />}
      >
        <MailNotices mail={mail} />
        <Row label="נשלחו היום">
          <span>
            {num(mail.used)} מתוך {num(mail.limit)}
          </span>
          <span className="muted">
            {num(mail.reserve)} אחרונות שמורות לקודים
          </span>
        </Row>
        <Row label="בתור">
          <span>{num(mail.pending)}</span>
          {num(mail.waitingForQuota) > 0 && (
            <Badge tone="warning">
              {num(mail.waitingForQuota)} ממתינות למכסה
            </Badge>
          )}
        </Row>
        <Row label="משלוח אחרון">
          <span>{displayDate(mail.lastSentAt, true)}</span>
        </Row>
        <Row label="כשלים בשבוע האחרון">
          <Badge tone={num(mail.failedThisWeek) ? "danger" : "success"}>
            {num(mail.failedThisWeek)}
          </Badge>
        </Row>
      </Panel>
      <Panel
        title="כשלים אחרונים"
        subtitle="הודעת האתר והפעולה עצמה נשמרו גם כשהמייל נכשל."
      >
        {failures.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>סוג</th>
                  <th>סיבה</th>
                  <th>ניסיונות</th>
                  <th>נוצר</th>
                  <th>נסגר</th>
                </tr>
              </thead>
              <tbody>
                {failures.map((row) => (
                  <tr key={row.id}>
                    <td>{kindLabels[str(row.kind)] ?? str(row.kind)}</td>
                    <td>{errorLabels[str(row.error)] ?? str(row.error)}</td>
                    <td>{num(row.attempts)}</td>
                    <td>{displayDate(row.createdAt, true)}</td>
                    <td>{displayDate(row.updatedAt, true)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="אין כשלים בשבוע האחרון" />
        )}
      </Panel>
    </>
  );
}
