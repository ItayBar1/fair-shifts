import { readPublicHealth } from "@/server/operations/health";

export const dynamic = "force-dynamic";

// Public probe for Docker and the tunnel. The site stays up while the worker is
// delayed, so only a missing database makes it unhealthy.
export async function GET() {
  const health = await readPublicHealth();
  return Response.json(health, {
    status: health.status === "ok" ? 200 : 503,
    headers: { "cache-control": "no-store" },
  });
}
