import type { MetadataRoute } from "next";
import { connection } from "next/server";
import { siteUrl } from "@/server/calendar/config";

/** Decision 243: the login screen is the only page search engines may list. */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  await connection();
  return [{ url: `${siteUrl()}/login` }];
}
