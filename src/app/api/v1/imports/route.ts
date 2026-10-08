import { getActor } from "@/server/auth";
import { executeAction } from "@/server/actions";
import { invariant } from "@/server/errors";
import { errorResponse, verifyOrigin } from "@/server/http";
import { parseImportWorkbook } from "@/server/import-workbook";
import { manager } from "@/server/repository";
import { readBoundedBody } from "@/server/bounded-body";
import { COMPRESSED_WORKBOOK_LIMIT } from "@/server/workbook-archive";

export async function POST(request: Request) {
  try {
    verifyOrigin(request);
    const actor = await getActor(request.headers);
    invariant(actor, "unauthorized", "יש להתחבר מחדש", 401);
    manager(actor);
    invariant(request.body, "invalid_workbook", "לא נשלח קובץ");
    const body = await readBoundedBody(
      request,
      COMPRESSED_WORKBOOK_LIMIT + 65536
    );
    const form = await new Request(request.url, {
      method: "POST",
      headers: { "content-type": request.headers.get("content-type") ?? "" },
      body: new Uint8Array(body),
    }).formData();
    const file = form.get("file");
    invariant(
      file instanceof File &&
        file.name.toLowerCase().endsWith(".xlsx") &&
        file.size <= COMPRESSED_WORKBOOK_LIMIT,
      "invalid_workbook",
      "יש לבחור קובץ XLSX עד 5MB"
    );
    const rows = await parseImportWorkbook(
      Buffer.from(await file.arrayBuffer())
    );
    return Response.json({
      result: await executeAction(actor, {
        type: "import.preview",
        payload: { filename: file.name.slice(0, 200), rows },
        idempotencyKey: form.get("idempotencyKey"),
      }),
    });
  } catch (error) {
    return errorResponse(error, { request });
  }
}
