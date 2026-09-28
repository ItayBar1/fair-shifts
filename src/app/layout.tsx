import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: {
    default: "תורנות הוגנת · Fair Shifts",
    template: "%s · תורנות הוגנת",
  },
  description: "לוח תורנויות משותף, שיבוץ הוגן ותמונה אחת לכל היחידה",
  robots: { index: false, follow: false },
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="he" dir="rtl">
      <body>{children}</body>
    </html>
  );
}
