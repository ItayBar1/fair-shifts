import { getActor } from "@/server/auth";
import { executeAction } from "@/server/actions";
import { invariant } from "@/server/errors";
import { errorResponse, verifyOrigin } from "@/server/http";
export async function POST(request: Request) {
  try {
    verifyOrigin(request);
    const actor = await getActor(request.headers);
    invariant(actor, "unauthorized", "יש להתחבר מחדש", 401);
    return Response.json({
      result: await executeAction(actor, await request.json()),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
