import { getActor } from "@/server/auth";
import { executeAction } from "@/server/actions";
import { invariant } from "@/server/errors";
import { errorResponse, verifyOrigin } from "@/server/http";
import {
  readBoundedBody,
  parseBoundedJson,
  ACTION_BODY_LIMIT,
} from "@/server/bounded-body";
export async function POST(request: Request) {
  try {
    verifyOrigin(request);
    const actor = await getActor(request.headers);
    invariant(actor, "unauthorized", "יש להתחבר מחדש", 401);
    return Response.json({
      result: await executeAction(
        actor,
        parseBoundedJson(await readBoundedBody(request, ACTION_BODY_LIMIT))
      ),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
