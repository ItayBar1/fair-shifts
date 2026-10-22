import type { Metadata } from "next";

// Decision 243: the login screen is the site's home page, so search engines may
// list it. Every other page keeps the root layout's noindex.
export const metadata: Metadata = { robots: { index: true, follow: true } };

export default function LoginLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return children;
}
