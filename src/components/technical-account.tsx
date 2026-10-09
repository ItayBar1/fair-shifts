"use client";
import {
  type AppState,
  type Action,
  displayDate,
  obj,
  str,
} from "@/client/types";
import { ActionDialog, Notice, Panel } from "./ui";

/**
 * The technical account's own screen (decision 204): who it is and the change
 * of its address. The change takes a code from each mailbox, so it is never a
 * single click on an open connection.
 */
export function TechnicalAccount({
  state,
  action,
}: {
  state: AppState;
  action: Action;
}) {
  const own = obj(state.ownAccount);
  const isManager = state.actor.role === "manager";
  const actionPrefix = isManager ? "manager.email" : "technical.email";
  const pending = obj(own.pendingEmailChange);
  const open = Boolean(pending.expiresAt);
  return (
    <>
      <Panel title="החשבון שלי">
        <div className="task-item">
          <strong className="grow">{state.actor.name}</strong>
          <span>{isManager ? "אחראי תורנויות" : "מנהל טכני"}</span>
        </div>
        <div className="task-item">
          <strong className="grow">כתובת המייל</strong>
          <span dir="ltr">{str(own.email, "—")}</span>
        </div>
      </Panel>
      <Panel
        title="החלפת כתובת מייל"
        subtitle="נשלחים שני קודים: אחד לכתובת הנוכחית ואחד לכתובת החדשה. ההחלפה מתבצעת רק כששניהם נכונים."
      >
        <p>
          אחרי ההחלפה כל החיבורים של החשבון מתבטלים, קישור Google הקודם מוסר
          והכניסה הבאה היא עם הכתובת החדשה, בקוד או ב־Google. אם הכתובת הנוכחית
          אינה זמינה,{" "}
          {isManager ? (
            "יש לפנות למנהל הטכני לחילוץ החשבון."
          ) : (
            <>
              מפעיל השרת מבצע את ההחלפה דרך השרת (
              <code dir="ltr">pnpm technical-email</code>).
            </>
          )}
        </p>
        {open && (
          <Notice>
            נשלחו קודים לכתובת הנוכחית ולכתובת{" "}
            <span dir="ltr">{str(pending.email)}</span>. הם תקפים עד{" "}
            {displayDate(pending.expiresAt, true)}. חמש טעויות מבטלות את הבקשה.
          </Notice>
        )}
        <div className="inline">
          <ActionDialog
            title="בקשת החלפת כתובת"
            buttonLabel={open ? "בקשה חדשה" : "בקשת החלפת כתובת"}
            fields={[
              {
                name: "email",
                label: "כתובת המייל החדשה",
                type: "email",
                required: true,
                hint: "כתובת מייל שבשליטתכם ושאינה רשומה באתר. קוד אימות יישלח אליה.",
              },
              { name: "reason", label: "סיבת ההחלפה", required: true },
            ]}
            action={action}
            submitLabel="שליחת הקודים"
            type={`${actionPrefix}.request`}
            description="הקודים נשלחים מיד. בקשה חדשה מבטלת את הקודמת, ומותרת בקשה אחת בדקה."
          />
          {open && (
            <ActionDialog
              title="אימות והחלפת הכתובת"
              buttonLabel="אימות והחלפת הכתובת"
              fields={[
                {
                  name: "currentCode",
                  label: "הקוד שנשלח לכתובת הנוכחית",
                  required: true,
                },
                {
                  name: "newCode",
                  label: "הקוד שנשלח לכתובת החדשה",
                  required: true,
                },
              ]}
              action={action}
              submitLabel="אימות והחלפה"
              type={`${actionPrefix}.confirm`}
              description="אחרי האימות תתבקשו להתחבר מחדש עם הכתובת החדשה."
            />
          )}
        </div>
      </Panel>
    </>
  );
}
