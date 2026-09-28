import { getAuth } from "@/server/auth";
import { errorResponse, verifyOrigin } from "@/server/http";

const publicPaths = new Set([
  "request-code",
  "verify-code",
  "recovery",
  "sign-in/social",
  "callback/google",
  "sign-out",
]);
async function handler(request: Request) {
  try {
    const path = new URL(request.url).pathname.replace(/^\/api\/auth\//, "");
    if (!publicPaths.has(path)) return new Response(null, { status: 404 });
    if (request.method === "POST") verifyOrigin(request);
    return await getAuth().handler(request);
  } catch (error) {
    return errorResponse(error);
  }
}
export const GET = handler;
export const POST = handler;
