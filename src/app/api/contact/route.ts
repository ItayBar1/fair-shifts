import { submitContactRequest } from "@/server/contact-requests";
import { errorResponse, verifyOrigin } from "@/server/http";

export const dynamic = "force-dynamic";

// The public contact form (decision 228). No sign-in; limited per sender and per day.
// The origin check keeps another site from spending the daily quota through visitors.
export async function POST(request: Request) {
  try {
    verifyOrigin(request);
    await submitContactRequest(request);
    return Response.json(
      { ok: true },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    return errorResponse(error, { request });
  }
}
