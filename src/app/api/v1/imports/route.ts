import { getActor } from "@/server/auth";
import { executeAction } from "@/server/actions";
import { invariant } from "@/server/errors";
import { errorResponse, verifyOrigin } from "@/server/http";
import { parseImportWorkbook } from "@/server/import-workbook";
import { manager } from "@/server/repository";

export async function POST(request: Request) {
  try {
    verifyOrigin(request);
    const actor = await getActor(request.headers);
    invariant(actor, "unauthorized", "יש להתחבר מחדש", 401);
    manager(actor);
    const length = request.headers.get("content-length");
    invariant(
      !length || Number(length) <= 5 * 1024 * 1024 + 65536,
      "invalid_workbook",
      "נדרש קובץ XLSX עד 5MB"
    );
    // Read a bounded body, including requests without Content-Length.
    invariant(request.body, "invalid_workbook", "לא נשלח קובץ");
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 5 * 1024 * 1024 + 65536) {
        await reader.cancel();
        invariant(false, "invalid_workbook", "נדרש קובץ XLSX עד 5MB");
      }
      chunks.push(chunk.value);
    }
    const form = await new Request(request.url, {
      method: "POST",
      headers: { "content-type": request.headers.get("content-type") ?? "" },
      body: Buffer.concat(chunks),
    }).formData();
    const file = form.get("file");
    invariant(
      file instanceof File &&
        file.name.toLowerCase().endsWith(".xlsx") &&
        file.size <= 5 * 1024 * 1024,
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
    return errorResponse(error);
  }
}
