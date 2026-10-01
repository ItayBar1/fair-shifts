import { getActor } from "@/server/auth";
import { readMyAssignments } from "@/server/my-assignments";
import { invariant } from "@/server/errors";
import { errorResponse } from "@/server/http";

export async function GET(request: Request) {
  try {
    const actor = await getActor(request.headers);
    invariant(actor, "unauthorized", "יש להתחבר מחדש", 401);
    const mailId = new URL(request.url).searchParams.get("mail") ?? undefined;
    return Response.json(await readMyAssignments(actor, mailId), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
