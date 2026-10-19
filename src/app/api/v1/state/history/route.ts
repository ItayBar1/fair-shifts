import { getActor } from "@/server/auth";
import { readHistory } from "@/server/state";
import { invariant } from "@/server/errors";
import { errorResponse } from "@/server/http";

/** An earlier slice of the soldier's history, before `before` (decision 235). */
export async function GET(request: Request) {
  try {
    const actor = await getActor(request.headers);
    invariant(actor, "unauthorized", "יש להתחבר מחדש", 401);
    const before = new Date(
      new URL(request.url).searchParams.get("before") ?? ""
    );
    invariant(
      !Number.isNaN(before.getTime()),
      "invalid_input",
      "חסר מועד תקין לטעינת היסטוריה"
    );
    return Response.json(await readHistory(actor, before), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error, { request });
  }
}
