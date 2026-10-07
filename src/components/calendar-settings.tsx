"use client";
import { useState } from "react";
import { createAuthClient } from "better-auth/client";
import { type Action, obj, str } from "@/client/types";
import { Notice, Panel, QuickAction } from "./ui";

const authClient = createAuthClient({ fetchOptions: { timeout: 15_000 } });

/**
 * Duties in the soldier's Google calendar (decision 195). One switch in four states:
 * blocked for an account that signed in with a code only, "permission needed" with a
 * button that goes to Google, on, and off. The permission is only ever given at
 * Google, in the same sign-in as always.
 */
export function CalendarSettings({
  calendar,
  action,
}: {
  calendar: unknown;
  action: Action;
}) {
  const info = obj(calendar);
  const state = str(info.state);
  const version = typeof info.version === "number" ? info.version : undefined;
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  if (!info.available || !state) return null;

  async function toggle(enabled: boolean) {
    setError("");
    setPending(true);
    try {
      await action("calendar.switch", { enabled }, version);
    } catch {
      /* The workspace shows the answer of the server. */
    } finally {
      setPending(false);
    }
  }
  // The same Google sign-in as the login page, asking again for the permission.
  async function grant() {
    setError("");
    setPending(true);
    try {
      const response = await authClient.signIn.social({
        provider: "google",
        callbackURL: "/settings",
        errorCallbackURL: "/settings",
        additionalParams: { prompt: "consent" },
        disableRedirect: true,
      });
      if (response.error || !response.data?.url)
        throw new Error("Google authorization is unavailable");
      window.location.assign(response.data.url);
    } catch {
      setError(
        "לא ניתן להגיע לאישור ב־Google כרגע. אפשר לנסות שוב מאוחר יותר."
      );
      setPending(false);
    }
  }

  return (
    <Panel title="יומן Google">
      <p className="muted">
        תורנות שפורסמה ושמשובצים אליה מתווספת אוטומטית ליומן ייעודי בשם
        ״תורנויות״ בחשבון ה־Google שלך. ההרשאה מוגבלת ליומן הזה: האתר אינו רואה
        או משנה את היומן הראשי שלך ואירועים אחרים. כדאי להשאיר את היומן
        ״תורנויות״ מסומן בתצוגה ביומן Google.
      </p>
      <label className="field check-field calendar-switch">
        <input
          type="checkbox"
          aria-label="הוספת תורנויות ליומן Google"
          checked={state === "on"}
          disabled={
            pending || state === "blocked" || state === "needs_permission"
          }
          onChange={(event) => void toggle(event.target.checked)}
        />
        <span>הוספת תורנויות ליומן Google</span>
      </label>
      {info.paused === true && (
        <Notice>
          הסנכרון ממתין לבדיקה של המנהל הטכני כדי לוודא שהיומן נוצר פעם אחת.
          אפשר להמשיך להשתמש באתר; יש לפנות למנהל הטכני להשלמת הבדיקה.
        </Notice>
      )}
      {state === "blocked" && (
        <Notice>
          כדי להוסיף את התורנויות ליומן Google יש להיכנס לאתר עם Google. כניסה
          עם קוד במייל אינה יכולה לתת את ההרשאה.
        </Notice>
      )}
      {state === "needs_permission" && (
        <>
          <Notice>
            האתר עדיין אינו מורשה להוסיף תורנויות ליומן Google שלך, או שההרשאה
            בוטלה. ההרשאה ניתנת באישור ב־Google, והאתר ממשיך לעבוד גם בלעדיה.
          </Notice>
          <div className="form-actions">
            <button
              className="btn primary"
              disabled={pending}
              onClick={() => void grant()}
            >
              אישור הרשאה ליומן
            </button>
          </div>
        </>
      )}
      {state === "on" && (
        <p className="muted">
          הסנכרון פעיל. שינוי של תורנות, העברה, החלפה וביטול מתעדכנים ביומן בתוך
          דקות. כיבוי המתג עוצר הוספה ועדכון של אירועים ואינו מסיר את הקיימים.
        </p>
      )}
      {state === "off" && (
        <>
          <p className="muted">
            הסנכרון כבוי: תורנויות חדשות ושינויים אינם מגיעים ליומן, והאירועים
            שכבר שם נשארים.
          </p>
          <div className="form-actions">
            {info.removing ? (
              <Notice>התורנויות העתידיות יוסרו מהיומן בדקות הקרובות.</Notice>
            ) : (
              <QuickAction
                action={action}
                type="calendar.remove.future"
                payload={{}}
                version={version}
              >
                הסרת התורנויות העתידיות מהיומן
              </QuickAction>
            )}
          </div>
        </>
      )}
      {error && <Notice tone="danger">{error}</Notice>}
    </Panel>
  );
}
