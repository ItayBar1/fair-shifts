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
  let actionType: unknown;
  try {
    verifyOrigin(request);
    const actor = await getActor(request.headers);
    invariant(actor, "unauthorized", "יש להתחבר מחדש", 401);
    const command = parseBoundedJson(
      await readBoundedBody(request, ACTION_BODY_LIMIT)
    );
    if (command && typeof command === "object" && "type" in command)
      actionType = command.type;
    return Response.json({
      result: await executeAction(actor, command),
    });
  } catch (error) {
    return errorResponse(error, { request, actionType });
  }
}
