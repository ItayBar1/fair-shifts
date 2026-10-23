import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "הדף לא נמצא" };

/**
 * Any address the site does not answer (#197). It needs no sign-in and shows
 * no unit data; the way back is the home page, which sends a signed-out
 * visitor to the login screen.
 */
export default function NotFound() {
  return (
    <main className="not-found-page">
      <section className="not-found-sheet" aria-labelledby="not-found-title">
        <Link className="brand" href="/">
          <span className="brand-mark">ת</span>
          <span>
            <strong>תורנות הוגנת</strong>
            <small>FAIR SHIFTS</small>
          </span>
        </Link>
        <h1 id="not-found-title">הדף לא נמצא</h1>
        <p>
          אין במערכת דף בכתובת הזאת. ייתכן שהקישור שגוי או ישן, או שהדף הוסר.
        </p>
        <p className="not-found-code">קוד שגיאה 404</p>
        <Link className="btn primary" href="/">
          חזרה למערכת
        </Link>
      </section>
    </main>
  );
}
