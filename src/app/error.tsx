"use client";
export default function ErrorPage({
  reset,
}: {
  error: Error;
  reset: () => void;
}) {
  return (
    <main className="loading-screen">
      <h1>לא הצלחנו להציג את המסך</h1>
      <p>אפשר לנסות שוב. המידע ששמרתם נשאר במערכת.</p>
      <button className="btn primary" onClick={reset}>
        לנסות שוב
      </button>
    </main>
  );
}
