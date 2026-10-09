import { getActor } from "@/server/auth";
import { readState } from "@/server/state";
import { invariant } from "@/server/errors";
import { errorResponse } from "@/server/http";
export async function GET(request: Request) {
  try {
    const actor = await getActor(request.headers);
    invariant(actor, "unauthorized", "יש להתחבר מחדש", 401);
    return Response.json(await readState(actor), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error, { request });
  }
}
