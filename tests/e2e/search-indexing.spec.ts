import { test, expect, type APIRequestContext } from "@playwright/test";

// Decision 243: search engines may list the login screen only. Every other page
// keeps noindex, and robots.txt lets crawlers read it.
async function robotsMeta(request: APIRequestContext, path: string) {
  const html = await (await request.get(path)).text();
  return html.match(/<meta name="robots" content="([^"]*)"/)?.[1];
}

test("only the login screen may be indexed by search engines", async ({
  request,
}) => {
  expect(await robotsMeta(request, "/login")).toBe("index, follow");
  for (const path of ["/", "/privacy", "/manage/soldiers"])
    expect(await robotsMeta(request, path)).toBe("noindex, nofollow");
});

test("robots.txt lets crawlers see each page's noindex and points to a sitemap of the login screen", async ({
  request,
}) => {
  const robots = await request.get("/robots.txt");
  expect(robots.status()).toBe(200);
  expect(robots.headers()["content-type"]).toContain("text/plain");
  const text = await robots.text();
  expect(text).toContain("User-Agent: *");
  expect(text).toContain("Allow: /");
  expect(text).toContain("Disallow: /api/");
  expect(text).not.toMatch(/^Disallow: \/$/m);
  const sitemapUrl = text.match(/^Sitemap: (\S+)$/m)?.[1];
  expect(sitemapUrl).toMatch(/^https?:\/\/[^/]+\/sitemap\.xml$/);

  const sitemap = await (await request.get("/sitemap.xml")).text();
  const urls = [...sitemap.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);
  expect(urls).toEqual([sitemapUrl!.replace(/sitemap\.xml$/, "login")]);
});
