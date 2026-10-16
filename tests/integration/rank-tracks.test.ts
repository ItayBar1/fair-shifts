import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, pool } from "../../src/server/db";
import {
  balances,
  records,
  soldierContacts,
  soldiers,
} from "../../src/server/schema";
import {
  createInvitedAccount,
  type Actor,
} from "../../src/server/auth/accounts";
import { executeAction } from "../../src/server/actions";
import { readState } from "../../src/server/state";
import { soldier, testIdNumber } from "../fixtures";

// Decision 223: tracks are managed on their own and a rank may sit in several
// tracks, with a place in each. Synthetic people and ranks only.
if (
  !process.env.TEST_DATABASE_URL ||
  process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL ||
  !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test")
)
  throw new Error("Integration tests require a dedicated *_test database");

let manager: Actor;
let member: Actor;

async function invite(
  name: string,
  role: "soldier" | "manager",
  personalNumber: string
): Promise<Actor> {
  const id = randomUUID();
  await db.insert(soldiers).values({
    id,
    name,
    idNumber: testIdNumber(personalNumber),
    data: soldier({ id, name }),
  });
  await db
    .insert(soldierContacts)
    .values({ soldierId: id, email: `${personalNumber}@example.invalid` });
  await db.insert(balances).values({ soldierId: id });
  const row = await createInvitedAccount({
    name,
    role,
    email: `${personalNumber}@example.invalid`,
    soldierId: id,
  });
  return { id: row.id, name, role, soldierId: id, securityEpoch: 1 };
}
async function command(
  type: string,
  payload: Record<string, unknown>,
  expectedVersion?: number
) {
  return (await executeAction(manager, {
    type,
    payload,
    expectedVersion,
    idempotencyKey: randomUUID(),
  })) as { id: string; version: number };
}
async function person(id = member.soldierId!) {
  return (await db.select().from(soldiers).where(eq(soldiers.id, id)))[0];
}
async function rankRecord(id: string) {
  return (await db.select().from(records).where(eq(records.id, id)))[0];
}
/** Conscripts end at staff sergeant; career NCOs start there (synthetic orders). */
async function catalog() {
  await command("rank.track.save", { name: "חוגרים", source: "בדיקה" });
  await command("rank.track.save", { name: "נגדים", source: "בדיקה" });
  const sergeant = await command("rank.catalog.save", {
    name: "סמל",
    tracks: [{ track: "חוגרים", order: 2 }],
    source: "בדיקה",
  });
  const staff = await command("rank.catalog.save", {
    name: "סמ״ר",
    tracks: [
      { track: "חוגרים", order: 3 },
      { track: "נגדים", order: 1 },
    ],
    source: "בדיקה",
  });
  const master = await command("rank.catalog.save", {
    name: "רס״ל",
    tracks: [{ track: "נגדים", order: 2 }],
    source: "בדיקה",
  });
  return { sergeant, staff, master };
}
async function setRank(rankId: string, effectiveDate = "2020-01-01") {
  return command(
    "rank.set",
    {
      soldierId: member.soldierId,
      rankId,
      effectiveDate,
      reason: "אישור סינתטי",
    },
    (await person()).version
  );
}

beforeEach(async () => {
  await db.execute(
    sql`truncate table auth_user, auth_budget, auth_rate_limit, soldiers, duty_types, unit_lock, email_quota, operations_state, command_results cascade`
  );
  manager = await invite("אחראי לבדיקה", "manager", "00002");
  member = await invite("חייל לבדיקה", "soldier", "00001");
});
afterAll(async () => pool.end());

describe("rank tracks", () => {
  it("keeps one rank in two tracks and asks for the soldier's track", async () => {
    const { staff } = await catalog();
    expect((await rankRecord(staff.id)).data.tracks).toEqual([
      { track: "חוגרים", order: 3 },
      { track: "נגדים", order: 1 },
    ]);
    await expect(setRank(staff.id)).rejects.toMatchObject({
      code: "rank_track_required",
    });
    // The form sends the rank and its track as one choice.
    await setRank(`${staff.id}|נגדים`);
    expect((await person()).data.rankHistory).toEqual([
      {
        effectiveFrom: "2020-01-01",
        rankId: staff.id,
        trackId: "נגדים",
        order: 1,
      },
    ]);
    const state = await readState(manager);
    expect(
      state.soldiers.find((row) => row.id === member.soldierId)
    ).toMatchObject({ rankId: staff.id, rankTrack: "נגדים" });
    expect(
      (state.rankTracks as { name: string }[]).map((row) => row.name).sort()
    ).toEqual(["חוגרים", "נגדים"]);
  });

  it("refuses a rank in a track that is not managed", async () => {
    await expect(
      command("rank.catalog.save", {
        name: "טוראי",
        tracks: [{ track: "לא קיים", order: 1 }],
        source: "בדיקה",
      })
    ).rejects.toMatchObject({ code: "unknown_track" });
  });

  it("keeps seniority rules inside the track of the soldier", async () => {
    const { sergeant, staff, master } = await catalog();
    const conscript = await command("rank.rule.save", {
      name: "סמל לסמ״ר",
      fromRankId: sergeant.id,
      toRankId: staff.id,
      months: 12,
      base: "rank",
      source: "בדיקה",
    });
    const career = await command("rank.rule.save", {
      name: "סמ״ר לרס״ל",
      fromRankId: staff.id,
      toRankId: master.id,
      months: 24,
      base: "rank",
      source: "בדיקה",
    });
    expect((await rankRecord(conscript.id)).data.track).toBe("חוגרים");
    expect((await rankRecord(career.id)).data.track).toBe("נגדים");
    await expect(
      command("rank.rule.save", {
        name: "רס״ל לסמל",
        fromRankId: master.id,
        toRankId: sergeant.id,
        months: 12,
        base: "rank",
        source: "בדיקה",
      })
    ).rejects.toMatchObject({ code: "rank_transition" });

    // A conscript staff sergeant gets no career reminder.
    await setRank(`${staff.id}|חוגרים`);
    expect((await readState(manager)).rankReminders).toEqual([]);
    await setRank(`${staff.id}|נגדים`, "2020-02-01");
    const [reminder] = (await readState(manager)).rankReminders as {
      id: string;
      version: number;
      status: string;
      track: string;
      toRankId: string;
    }[];
    expect(reminder).toMatchObject({
      status: "pending",
      track: "נגדים",
      toRankId: master.id,
    });
    await command(
      "rank.approve",
      { id: reminder.id, effectiveDate: "2022-02-01", reason: "אישור סינתטי" },
      reminder.version
    );
    expect((await person()).data.rankHistory.at(-1)).toMatchObject({
      rankId: master.id,
      trackId: "נגדים",
      order: 2,
    });
  });

  it("warns before removing a rank from a track in use, then saves on confirmation", async () => {
    const { staff } = await catalog();
    await setRank(`${staff.id}|נגדים`);
    const before = await rankRecord(staff.id);
    const payload = {
      id: staff.id,
      name: "סמ״ר",
      tracks: [{ track: "חוגרים", order: 3 }],
      source: "בדיקה",
    };
    await expect(
      command("rank.catalog.save", payload, before.version)
    ).rejects.toMatchObject({
      code: "rank_track_in_use",
      status: 409,
      details: {
        conflicts: [
          expect.objectContaining({
            track: "נגדים",
            soldiers: ["חייל לבדיקה"],
          }),
        ],
      },
    });
    await command(
      "rank.catalog.save",
      { ...payload, usageConfirmed: true },
      before.version
    );
    expect((await rankRecord(staff.id)).data.tracks).toEqual([
      { track: "חוגרים", order: 3 },
    ]);
    // The soldier keeps the rank in that track until a manager updates it.
    expect((await person()).data.rankHistory[0].trackId).toBe("נגדים");
    const audit = await db
      .select()
      .from(records)
      .where(eq(records.kind, "audit"));
    expect(
      audit.filter((row) => row.data.action === "rank.catalog.usage_confirmed")
    ).toHaveLength(1);
  });

  it("moves a rank within a track and carries the new place to its holders", async () => {
    const { staff } = await catalog();
    await setRank(`${staff.id}|נגדים`);
    const before = await rankRecord(staff.id);
    await command(
      "rank.catalog.save",
      {
        id: staff.id,
        name: "סמ״ר",
        tracks: [
          { track: "חוגרים", order: 3 },
          { track: "נגדים", order: 0 },
        ],
        source: "בדיקה",
        usageConfirmed: true,
      },
      before.version
    );
    expect((await person()).data.rankHistory[0]).toMatchObject({
      trackId: "נגדים",
      order: 0,
    });
  });

  it("adds a rank to another track without any warning", async () => {
    const { sergeant } = await catalog();
    await setRank(`${sergeant.id}|חוגרים`);
    const before = await rankRecord(sergeant.id);
    await command(
      "rank.catalog.save",
      {
        id: sergeant.id,
        name: "סמל",
        tracks: [
          { track: "חוגרים", order: 2 },
          { track: "נגדים", order: 0 },
        ],
        source: "בדיקה",
      },
      before.version
    );
    expect((await rankRecord(sergeant.id)).data.tracks).toHaveLength(2);
  });

  it("renames an unused track with its ranks, and keeps a used or full track", async () => {
    const { staff } = await catalog();
    const spare = await command("rank.track.save", {
      name: "קמ״א",
      source: "בדיקה",
    });
    await command(
      "rank.track.save",
      { id: spare.id, name: "קמ״א חדש", source: "בדיקה" },
      spare.version
    );
    await setRank(`${staff.id}|נגדים`);
    const tracks = await db
      .select()
      .from(records)
      .where(eq(records.kind, "rank_track"));
    const career = tracks.find((row) => row.data.name === "נגדים")!;
    await expect(
      command(
        "rank.track.save",
        { id: career.id, name: "נגדים חדש", source: "בדיקה" },
        career.version
      )
    ).rejects.toMatchObject({ code: "rank_track_in_use" });
    await expect(
      command("rank.track.delete", { id: career.id }, career.version)
    ).rejects.toMatchObject({ code: "rank_track_not_empty" });
    const renamed = tracks.find((row) => row.id === spare.id)!;
    await command("rank.track.delete", { id: renamed.id }, renamed.version);
    expect(
      (
        await db.select().from(records).where(eq(records.kind, "rank_track"))
      ).map((row) => row.data.name)
    ).not.toContain("קמ״א חדש");
  });

  it("migrates a rank saved with one track into a managed track", async () => {
    await db.insert(records).values({
      id: randomUUID(),
      kind: "rank_catalog",
      data: { name: "טוראי ישן", track: "ישן", order: 4, source: "בדיקה" },
    });
    const migration = readFileSync("drizzle/0019_rank_tracks.sql", "utf8");
    for (const statement of migration.split("--> statement-breakpoint"))
      await db.execute(sql.raw(statement));
    const rows = await db.select().from(records);
    expect(rows.find((row) => row.kind === "rank_catalog")?.data).toMatchObject(
      { name: "טוראי ישן", tracks: [{ track: "ישן", order: 4 }] }
    );
    expect(
      rows.find((row) => row.kind === "rank_catalog")?.data
    ).not.toHaveProperty("track");
    expect(
      rows
        .filter((row) => row.kind === "rank_track")
        .map((row) => row.data.name)
    ).toEqual(["ישן"]);
  });
});
