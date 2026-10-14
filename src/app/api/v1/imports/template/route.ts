import { eq } from "drizzle-orm";
import { getActor } from "@/server/auth";
import { db } from "@/server/db";
import { invariant } from "@/server/errors";
import { errorResponse } from "@/server/http";
import { createImportTemplate } from "@/server/import-workbook";
import { manager } from "@/server/repository";
import { records, soldiers } from "@/server/schema";

export async function GET(request: Request) {
  try {
    const actor = await getActor(request.headers);
    invariant(actor, "unauthorized", "יש להתחבר מחדש", 401);
    manager(actor);
    const ranks = await db
      .select()
      .from(records)
      .where(eq(records.kind, "rank_catalog"));
    const people = (await db.select().from(soldiers))
      .filter((row) => !row.deletedAt)
      .sort((a, b) => a.idNumber - b.idNumber)
      .map((row) => ({
        idNumber: row.idNumber,
        firstName: row.data.firstName ?? row.name,
        lastName: row.data.lastName ?? "",
      }));
    const data = await createImportTemplate(
      ranks.map((rank) => ({
        name: String(rank.data.name),
        track: String(rank.data.track),
      })),
      people
    );
    return new Response(new Uint8Array(data), {
      headers: {
        "content-type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": 'attachment; filename="fair-shifts-import.xlsx"',
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return errorResponse(error, { request });
  }
}
