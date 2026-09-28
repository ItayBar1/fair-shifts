"use client";
import { useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ShieldCheck,
  CalendarDays,
  Scale,
  Mail,
  LockKeyhole,
} from "lucide-react";
import { Notice } from "@/components/ui";
const subscribe = () => () => {};
export default function LoginPage() {
  const ready = useSyncExternalStore(
    subscribe,
    () => true,
    () => false
  );
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [resendAt, setResendAt] = useState(0);
  const [recovery, setRecovery] = useState(false);
  async function post(path: string, body: Record<string, string>) {
    setError("");
    setPending(true);
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(
          data.error?.message ||
            data.message ||
            "לא ניתן להשלים את הכניסה כרגע."
        );
      return data;
    } catch (e) {
      setError(e instanceof Error ? e.message : "אירעה שגיאה. נסו שוב.");
      return null;
    } finally {
      setPending(false);
    }
  }
  return (
    <main className="login-page">
      <section className="login-story">
        <Link className="brand light" href="/login">
          <span className="brand-mark">ת</span>
          <span>
            <strong>תורנות הוגנת</strong>
            <small>FAIR SHIFTS</small>
          </span>
        </Link>
        <div className="login-story-content">
          <span className="eyebrow">כל היחידה. אותה תמונה.</span>
          <h1>
            תכנון ברור.
            <br />
            חלוקה הוגנת.
            <br />
            <span>ראש שקט.</span>
          </h1>
          <p>
            הלוח, האילוצים וההחלפות במקום אחד —<br />
            כדי שתמיד יהיה ברור מי, מתי ולמה.
          </p>
          <div className="login-benefits">
            <span>
              <CalendarDays size={19} />
              לוח תורנויות משותף
            </span>
            <span>
              <Scale size={19} />
              ניקוד שקוף לכולם
            </span>
            <span>
              <ShieldCheck size={19} />
              גישה מאובטחת ליחידה
            </span>
          </div>
        </div>
        <p className="login-story-footer">מערכת ניהול התורנויות של היחידה</p>
        <div className="decor-grid" aria-hidden="true" />
      </section>
      <section className="login-form-side">
        <div className="login-form">
          <div className="login-icon">
            <LockKeyhole size={27} />
          </div>
          <div className="eyebrow">ברוכים הבאים</div>
          <h2>
            {recovery
              ? "שחזור גישה טכנית"
              : sent
                ? "הקוד בדרך אליך"
                : "נכנסים למרחב היחידה"}
          </h2>
          <p>
            {recovery
              ? "מזינים קוד שחזור חד־פעמי שנשמר בעת הקמת החשבון."
              : sent
                ? `אם הכתובת ${email} מורשית, יישלח אליה קוד כניסה. הקוד תקף לעשר דקות.`
                : "הכניסה מיועדת לחשבונות שהוזמנו על ידי אחראי התורנויות."}
          </p>
          {error && <Notice tone="danger">{error}</Notice>}
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (recovery) {
                const result = await post("/api/auth/recovery", {
                  email,
                  code,
                });
                if (result) {
                  setRecovery(false);
                  setCode("");
                  setError(
                    "הגישה שוחזרה. יש להתחבר מחדש עם קוד למייל או Google."
                  );
                }
              } else if (sent) {
                const result = await post("/api/auth/verify-code", {
                  email,
                  code,
                });
                if (result) router.push("/calendar");
              } else {
                const result = await post("/api/auth/request-code", { email });
                if (result) {
                  setSent(true);
                  setResendAt(Date.now() + 60000);
                }
              }
            }}
          >
            <label className="field">
              <span>כתובת המייל המאושרת</span>
              <input
                type="email"
                dir="ltr"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={!ready || (sent && !recovery)}
                placeholder="name@example.com"
              />
            </label>
            {(sent || recovery) && (
              <label className="field">
                <span>{recovery ? "קוד שחזור" : "קוד כניסה"}</span>
                <input
                  type="text"
                  inputMode={recovery ? "text" : "numeric"}
                  autoComplete="one-time-code"
                  required
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  dir="ltr"
                  autoFocus
                  className="code-input"
                />
              </label>
            )}
            <button
              type="submit"
              className="btn primary login-submit"
              disabled={!ready || pending}
            >
              {pending ? (
                <span className="spinner small" />
              ) : sent || recovery ? (
                <ArrowLeft size={18} />
              ) : (
                <Mail size={18} />
              )}{" "}
              {pending
                ? "רגע אחד…"
                : sent || recovery
                  ? "כניסה לחשבון"
                  : "שליחת קוד למייל"}
            </button>
          </form>
          {sent && !recovery ? (
            <div className="login-secondary">
              <button
                type="button"
                onClick={async () => {
                  if (Date.now() < resendAt) {
                    setError("אפשר לשלוח קוד נוסף דקה לאחר השליחה הקודמת.");
                    return;
                  }
                  const result = await post("/api/auth/request-code", {
                    email,
                  });
                  if (result) setResendAt(Date.now() + 60000);
                }}
                disabled={!ready || pending}
              >
                שליחה חוזרת
              </button>
              <button
                type="button"
                onClick={() => {
                  setSent(false);
                  setCode("");
                  setError("");
                }}
              >
                שינוי כתובת מייל
              </button>
            </div>
          ) : (
            !recovery && (
              <>
                <div className="divider">
                  <span>או</span>
                </div>
                <button
                  className="btn google-button"
                  disabled={!ready || pending}
                  onClick={async () => {
                    const result = await post("/api/auth/sign-in/social", {
                      provider: "google",
                      callbackURL: "/calendar",
                    });
                    if (result?.url) window.location.assign(result.url);
                  }}
                >
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path
                      fill="#4285F4"
                      d="M21.6 12.23c0-.71-.06-1.39-.18-2.04H12v3.86h5.38a4.6 4.6 0 0 1-2 3.02v2.51h3.24c1.9-1.74 2.98-4.31 2.98-7.35Z"
                    />
                    <path
                      fill="#34A853"
                      d="M12 22c2.7 0 4.96-.9 6.62-2.42l-3.24-2.51c-.89.6-2.03.96-3.38.96-2.6 0-4.8-1.76-5.59-4.12H3.07v2.6A10 10 0 0 0 12 22Z"
                    />
                    <path
                      fill="#FBBC05"
                      d="M6.41 13.91A6 6 0 0 1 6.1 12c0-.66.11-1.3.31-1.91v-2.6H3.07A10 10 0 0 0 2 12c0 1.62.39 3.15 1.07 4.51l3.34-2.6Z"
                    />
                    <path
                      fill="#EA4335"
                      d="M12 5.97c1.47 0 2.8.51 3.84 1.51l2.88-2.88A9.6 9.6 0 0 0 12 2a10 10 0 0 0-8.93 5.49l3.34 2.6A5.98 5.98 0 0 1 12 5.97Z"
                    />
                  </svg>{" "}
                  כניסה עם Google
                </button>
              </>
            )
          )}
          <div className="login-help">
            <ShieldCheck size={17} />
            <p>
              לא קיבלתם הזמנה או שהחשבון ננעל?
              <br />
              פנו לאחראי התורנויות ביחידה.
            </p>
          </div>
          <button
            className="text-button recovery-link"
            onClick={() => {
              setRecovery(!recovery);
              setSent(false);
              setCode("");
              setError("");
            }}
          >
            {recovery ? "חזרה לכניסה רגילה" : "שחזור חשבון מנהל טכני"}
          </button>
        </div>
        <p className="login-privacy">
          משתמשים בעוגיות נחוצות להתחברות ולאבטחה בלבד.
        </p>
      </section>
    </main>
  );
}
