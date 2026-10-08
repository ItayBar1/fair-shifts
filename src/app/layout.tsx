import type { Metadata } from "next";
import { connection } from "next/server";
import "./globals.css";
export const metadata: Metadata = {
  title: {
    default: "תורנות הוגנת · Fair Shifts",
    template: "%s · תורנות הוגנת",
  },
  description: "לוח תורנויות משותף, שיבוץ הוגן ותמונה אחת לכל היחידה",
  robots: { index: false, follow: false },
};
export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // Every HTML response, including login and errors, needs a fresh nonce.
  await connection();
  return (
    <html lang="he" dir="rtl">
      <body>{children}</body>
    </html>
  );
}
