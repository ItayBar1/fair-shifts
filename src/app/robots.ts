import type { MetadataRoute } from "next";
import { connection } from "next/server";
import { siteUrl } from "@/server/calendar/config";

/**
 * Decision 243: crawlers may read every page, so they see each page's noindex;
 * only /login allows indexing. A Disallow here would hide that noindex.
 */
export default async function robots(): Promise<MetadataRoute.Robots> {
  // The address comes from the deployment, not from the build.
  await connection();
  return {
    rules: { userAgent: "*", allow: "/", disallow: "/api/" },
    sitemap: `${siteUrl()}/sitemap.xml`,
  };
}
