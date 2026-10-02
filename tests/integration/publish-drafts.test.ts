import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { db, pool } from "../../src/server/db";
import { emailOutbox } from "../../src/server/auth-schema";
import {
  assignments,
  balances,
  duties,
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
import type { AuditEntry } from "../../src/server/audit-log";
import { soldier } from "../fixtures";

if (
  !process.env.TEST_DATABASE_URL ||
  process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL ||
  !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test")
)
  throw new Error("Integration tests require a dedicated *_test database");

let manager: Actor;
let other: Actor;
let technical: Actor;
let avi: Actor;
let bar: Actor;
let serial = 10;

async function invite(
  name: string,
  role: "soldier" | "manager"
): Promise<Actor> {
  const id = randomUUID();
  const personalNumber = String(serial++).padStart(5, "0");
  await db.insert(soldiers).values({
    id,
    name,
    personalNumber,
    data: soldier({ id, name, personalNumber }),
  });
  await db
    .insert(soldierContacts)
    .values({ soldierId: id, email: `${personalNumber}@example.invalid` });
  await db.insert(balances).values({ soldierId: id, current: 100 });
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
  expectedVersion?: number,
  actor = manager,
  idempotencyKey = randomUUID()
) {
  return (await executeAction(actor, {
    type,
    payload,
    expectedVersion,
    idempotencyKey,
  })) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}
/** Israel-time instants `days` ahead at `hour`, lasting `hours`. */
function at(days: number, hour: number, hours = 8) {
  const start = DateTime.now()
    .setZone("Asia/Jerusalem")
    .startOf("day")
    .plus({ days, hours: hour });
  return { start: start.toISO()!, end: start.plus({ hours }).toISO()! };
}
const dayOf = (value: string) =>
  DateTime.fromISO(value).setZone("Asia/Jerusalem").toISODate()!;

let typeId: string;
async function draft(name: string, when: { start: string; end: string }) {
  const created = await command("duty.create", { typeId, name, ...when });
  return created.id as string;
}
async function version(id: string) {
  const [row] = await db.select().from(duties).where(eq(duties.id, id));
  return row;
}
async function assign(dutyId: string, person: Actor, actor = manager) {
  const row = await version(dutyId);
  const taken = (
    await db.execute(
      sql`select slot_id from assignments where duty_id = ${dutyId} and status <> 'cancelled'`
    )
  ).rows.map((item) => item.slot_id);
  const slot = row.data.slots.find((item) => !taken.includes(item.id))!;
  await command(
    "duty.assign",
    { dutyId, slotId: slot.id, soldierId: person.soldierId },
    row.version,
    actor
  );
}
async function inactive(person: Actor, on: string) {
  const payload = {
    soldierId: person.soldierId,
    kind: "inactive",
    startDate: on,
    endDate: on,
    reason: "אי־פעילות סינתטית",
  };
  const [row] = await db
    .select()
    .from(soldiers)
    .where(eq(soldiers.id, person.soldierId!));
  const preview = await command(
    "soldier.timeline.preview",
    payload,
    row.version
  );
  await command(
    "soldier.timeline",
    { ...payload, confirmed: true, previewToken: preview.previewToken },
    row.version
  );
}
const mails = async () =>
  (await db.select().from(emailOutbox)).filter(
    (row) => row.kind === "publication"
  );
const notices = async () =>
  (await db.select().from(records)).filter(
    (row) => row.kind === "notification"
  );
const audits = async (action: string) =>
  (await db.select().from(records)).filter(
    (row) => row.kind === "audit" && row.data.action === action
  );
const statuses = async (...ids: string[]) =>
  Promise.all(ids.map(async (id) => (await version(id)).data.status));

/**
 * Three drafts: d1 (two seats, Avi in one), d2 (Bar), d3 (Avi). Bar is then made
 * inactive on d2's day, so d2 is the one that is blocked.
 */
async function threeDrafts(block = true) {
  const d1 = await draft("תורנות ראשונה", at(5, 8));
  const d2 = await draft("תורנות שנייה", at(5, 20));
  const d3 = await draft("תורנות שלישית", at(6, 8));
  await assign(d1, avi);
  await assign(d2, bar);
  await assign(d3, avi);
  if (block) await inactive(bar, dayOf(at(5, 20).start));
  return { d1, d2, d3, all: [d1, d2, d3] };
}

beforeEach(async () => {
  await db.execute(
    sql`truncate table auth_user, soldiers, duty_types, unit_lock, email_quota, operations_state, command_results cascade`
  );
  serial = 10;
  const tech = await createInvitedAccount({
    name: "טכני לבדיקה",
    role: "technical",
    email: "technical@example.invalid",
  });
  technical = {
    id: tech.id,
    name: tech.name,
    role: "technical",
    securityEpoch: 1,
  };
  manager = await invite("אחראי ראשון", "manager");
  other = await invite("אחראי שני", "manager");
  avi = await invite("אביב", "soldier");
  bar = await invite("בר", "soldier");
  typeId = (
    await command("dutyType.save", {
      name: "שמירה לפרסום מרובה",
      pricing: { mode: "fixed", base: 4 },
      roles: [{ name: "תורן", count: 2 }],
    })
  ).id;
});
afterAll(async () => pool.end());

describe("publishing several drafts at once", () => {
  it("previews each draft as ready or blocked with the reason, and saves nothing", async () => {
    const { d1, d2, d3, all } = await threeDrafts();
    const before = await Promise.all(all.map(version));
    const preview = await command("duty.publish.preview", {
      dutyIds: [d3, d2, d1],
    });
    expect(preview).toMatchObject({ ready: 2, blocked: 1 });
    // By start time, whatever the order the caller named them in.
    expect(preview.duties.map((row: { id: string }) => row.id)).toEqual([
      d1,
      d2,
      d3,
    ]);
    const [first, second, third] = preview.duties;
    expect(first).toMatchObject({
      ready: true,
      seated: 1,
      vacant: 1,
      version: before[0].version,
    });
    expect(second).toMatchObject({ ready: false, code: "assignment_changed" });
    expect(second.reason).toContain("השיבוץ של בר אינו תקין עוד");
    expect(second.reason).toContain("אי־פעילות");
    expect(third.ready).toBe(true);
    expect(typeof preview.token).toBe("string");

    expect(await statuses(...all)).toEqual(["draft", "draft", "draft"]);
    expect(
      (await Promise.all(all.map(version))).map((row) => row.version)
    ).toEqual(before.map((row) => row.version));
    expect(await mails()).toEqual([]);
    expect(await notices()).toEqual([]);
    expect(await audits("duty.publish")).toEqual([]);
  });

  it("publishes the ready drafts together and leaves a blocked draft a draft", async () => {
    const { d1, d2, d3, all } = await threeDrafts();
    const before = await Promise.all(all.map(version));
    const preview = await command("duty.publish.preview", { dutyIds: all });
    const result = await command("duty.publish.batch", {
      dutyIds: all,
      token: preview.token,
      confirmed: true,
    });

    expect(result.published.map((row: { id: string }) => row.id)).toEqual([
      d1,
      d3,
    ]);
    expect(result.blocked).toEqual([
      { id: d2, name: "תורנות שנייה", reason: expect.stringContaining("בר") },
    ]);
    expect(await statuses(...all)).toEqual(["published", "draft", "published"]);
    // Each published duty rises a version, as in a single publish; the draft stays as it was.
    const after = await Promise.all(all.map(version));
    expect(after.map((row) => row.version)).toEqual([
      before[0].version + 1,
      before[1].version,
      before[2].version + 1,
    ]);
    expect(after[0].data.publishedAt).toBeTruthy();
    expect(after[1].data.publishedAt).toBeUndefined();

    // Until the single mail per soldier exists (#97), each duty tells its soldiers as today.
    const notified = await notices();
    expect(notified).toHaveLength(2);
    expect(new Set(notified.map((row) => row.data.accountId))).toEqual(
      new Set([avi.id])
    );
    expect(notified.map((row) => row.data.body).sort()).toEqual([
      "שובצת לתורנות תורנות ראשונה",
      "שובצת לתורנות תורנות שלישית",
    ]);
    expect((await mails()).map((row) => row.eventKey).sort()).toEqual(
      [
        `publish:${d1}:${before[0].version + 1}:${avi.id}`,
        `publish:${d3}:${before[2].version + 1}:${avi.id}`,
      ].sort()
    );

    // One audit record per published duty, tied to the batch, and one for the batch.
    const each = await audits("duty.publish");
    expect(each.map((row) => row.data.targetId).sort()).toEqual(
      [d1, d3].sort()
    );
    expect(each.every((row) => row.data.batchId === result.batchId)).toBe(true);
    const [batch] = await audits("duty.publish.batch");
    expect(batch.data).toMatchObject({
      targetId: result.batchId,
      dutyIds: [d1, d3],
      blockedIds: [d2],
    });
    // The envelope names ids only: the block reason names a soldier.
    expect(JSON.stringify(batch.data)).not.toContain("בר");

    const log = (await readState(manager)).audit as AuditEntry[];
    const entry = log.find((row) => row.action === "duty.publish.batch")!;
    expect(entry.label).toBe("פרסום כמה תורנויות");
    expect(entry.details).toEqual([
      { label: "תורנויות שפורסמו", value: "2" },
      { label: "נשארו טיוטה", value: "1" },
    ]);
    expect(entry.refs).toEqual(expect.arrayContaining([d1, d2, d3]));
    expect(log.filter((row) => row.action === "duty.publish")).toHaveLength(2);
  });

  it("publishes a draft with open seats, as a single publish does", async () => {
    const { d1 } = await threeDrafts(false);
    const preview = await command("duty.publish.preview", { dutyIds: [d1] });
    expect(preview.duties[0]).toMatchObject({ ready: true, vacant: 1 });
    await command("duty.publish.batch", {
      dutyIds: [d1],
      token: preview.token,
      confirmed: true,
    });
    expect(await statuses(d1)).toEqual(["published"]);
  });

  it("agrees with a single publish on every draft", async () => {
    const { d1, d2 } = await threeDrafts();
    const preview = await command("duty.publish.preview", {
      dutyIds: [d1, d2],
    });
    expect(preview.duties.map((row: { ready: boolean }) => row.ready)).toEqual([
      true,
      false,
    ]);
    const blocked = await version(d2);
    await expect(
      command("duty.publish", { id: d2, confirmed: true }, blocked.version)
    ).rejects.toMatchObject({
      code: "assignment_changed",
      status: 422,
      message: "נתוני השיבוץ השתנו. יש לטפל בהתאמה לפני פרסום",
    });
    const ready = await version(d1);
    await command("duty.publish", { id: d1, confirmed: true }, ready.version);
    expect(await statuses(d1, d2)).toEqual(["published", "draft"]);
  });

  it("rejects the whole action when a selected draft changed since the preview, by either manager", async () => {
    const { d1, all } = await threeDrafts(false);
    const preview = await command("duty.publish.preview", { dutyIds: all });
    // The other manager fills d1's second seat.
    await assign(d1, bar, other);
    await expect(
      command("duty.publish.batch", {
        dutyIds: all,
        token: preview.token,
        confirmed: true,
      })
    ).rejects.toMatchObject({ code: "stale_publish_preview", status: 409 });
    expect(await statuses(...all)).toEqual(["draft", "draft", "draft"]);
    expect(await mails()).toEqual([]);
    expect(await notices()).toEqual([]);
    expect(await audits("duty.publish.batch")).toEqual([]);

    // A fresh preview shows the change and publishes.
    const fresh = await command("duty.publish.preview", { dutyIds: all });
    expect(fresh.duties[0]).toMatchObject({ id: d1, seated: 2, vacant: 0 });
    expect(fresh.token).not.toBe(preview.token);
    await command("duty.publish.batch", {
      dutyIds: all,
      token: fresh.token,
      confirmed: true,
    });
    expect(await statuses(...all)).toEqual([
      "published",
      "published",
      "published",
    ]);
  });

  it("rejects the action when readiness changed since the preview, in either direction", async () => {
    const { d1, d2, all } = await threeDrafts();
    const preview = await command("duty.publish.preview", { dutyIds: all });
    // Bar's inactive period is ended by a manager: d2 would now be ready.
    const [row] = await db
      .select()
      .from(soldiers)
      .where(eq(soldiers.id, bar.soldierId!));
    await db
      .update(soldiers)
      .set({
        data: { ...row.data, inactivePeriods: [] },
        version: row.version + 1,
      })
      .where(eq(soldiers.id, bar.soldierId!));
    await expect(
      command("duty.publish.batch", {
        dutyIds: all,
        token: preview.token,
        confirmed: true,
      })
    ).rejects.toMatchObject({ code: "stale_publish_preview", status: 409 });
    expect(await statuses(...all)).toEqual(["draft", "draft", "draft"]);

    // And the other way: d1 becomes blocked after a preview that showed it ready.
    const again = await command("duty.publish.preview", { dutyIds: [d1, d2] });
    await inactive(avi, dayOf(at(5, 8).start));
    await expect(
      command("duty.publish.batch", {
        dutyIds: [d1, d2],
        token: again.token,
        confirmed: true,
      })
    ).rejects.toMatchObject({ code: "stale_publish_preview", status: 409 });
    expect(await statuses(d1, d2)).toEqual(["draft", "draft"]);
  });

  it("catches a seat that moved to another soldier even when the duty's version did not rise", async () => {
    const { d1 } = await threeDrafts(false);
    const preview = await command("duty.publish.preview", { dutyIds: [d1] });
    const [seat] = await db
      .select()
      .from(assignments)
      .where(eq(assignments.dutyId, d1));
    await db
      .update(assignments)
      .set({
        soldierId: bar.soldierId!,
        version: seat.version + 1,
        data: {
          ...seat.data,
          soldierId: bar.soldierId!,
          version: seat.version + 1,
        },
      })
      .where(eq(assignments.id, seat.id));
    await expect(
      command("duty.publish.batch", {
        dutyIds: [d1],
        token: preview.token,
        confirmed: true,
      })
    ).rejects.toMatchObject({ code: "stale_publish_preview", status: 409 });
    expect(await statuses(d1)).toEqual(["draft"]);
  });

  it("refuses a token that was not issued for these drafts", async () => {
    const { d1, d3 } = await threeDrafts(false);
    const preview = await command("duty.publish.preview", { dutyIds: [d1] });
    await expect(
      command("duty.publish.batch", {
        dutyIds: [d1, d3],
        token: preview.token,
        confirmed: true,
      })
    ).rejects.toMatchObject({ code: "stale_publish_preview" });
    await expect(
      command("duty.publish.batch", {
        dutyIds: [d1],
        token: "forged",
        confirmed: true,
      })
    ).rejects.toMatchObject({ code: "stale_publish_preview" });
    expect(await statuses(d1, d3)).toEqual(["draft", "draft"]);
  });

  it("lets only one of two managers publish the same drafts, and tells nobody twice", async () => {
    const { all } = await threeDrafts(false);
    const first = await command("duty.publish.preview", { dutyIds: all });
    const second = await command(
      "duty.publish.preview",
      { dutyIds: all },
      undefined,
      other
    );
    await command("duty.publish.batch", {
      dutyIds: all,
      token: first.token,
      confirmed: true,
    });
    const sent = (await mails()).length;
    const told = (await notices()).length;
    expect(sent).toBeGreaterThan(0);
    await expect(
      command(
        "duty.publish.batch",
        { dutyIds: all, token: second.token, confirmed: true },
        undefined,
        other
      )
    ).rejects.toMatchObject({ code: "stale_publish_preview", status: 409 });
    expect((await mails()).length).toBe(sent);
    expect((await notices()).length).toBe(told);
    expect(await audits("duty.publish.batch")).toHaveLength(1);
  });

  it("does not publish or send twice when the same request is sent again", async () => {
    const { all } = await threeDrafts(false);
    const preview = await command("duty.publish.preview", { dutyIds: all });
    const key = randomUUID();
    const send = () =>
      command(
        "duty.publish.batch",
        { dutyIds: all, token: preview.token, confirmed: true },
        undefined,
        manager,
        key
      );
    const first = await send();
    const sent = (await mails()).length;
    const second = await send();
    expect(second).toEqual(first);
    expect((await mails()).length).toBe(sent);
    expect(await audits("duty.publish.batch")).toHaveLength(1);
    // The same payload under a new key is a new request, and the drafts are not drafts any more.
    await expect(
      command("duty.publish.batch", {
        dutyIds: all,
        token: preview.token,
        confirmed: true,
      })
    ).rejects.toMatchObject({ code: "stale_publish_preview" });
    // The same key with other contents is refused.
    await expect(
      command(
        "duty.publish.batch",
        { dutyIds: all.slice(1), token: preview.token, confirmed: true },
        undefined,
        manager,
        key
      )
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("rejects an approval that would publish nothing", async () => {
    const { d2 } = await threeDrafts();
    const preview = await command("duty.publish.preview", { dutyIds: [d2] });
    expect(preview).toMatchObject({ ready: 0, blocked: 1 });
    await expect(
      command("duty.publish.batch", {
        dutyIds: [d2],
        token: preview.token,
        confirmed: true,
      })
    ).rejects.toMatchObject({ code: "nothing_to_publish", status: 422 });
    expect(await statuses(d2)).toEqual(["draft"]);
  });

  it("does not publish a draft that has already been published, cancelled or has started", async () => {
    const { d1, d2, d3 } = await threeDrafts(false);
    const published = await version(d1);
    await command(
      "duty.publish",
      { id: d1, confirmed: true },
      published.version
    );
    const cancelled = await version(d2);
    await db
      .update(duties)
      .set({ data: { ...cancelled.data, status: "cancelled" } })
      .where(eq(duties.id, d2));
    const started = await version(d3);
    const begun = DateTime.now().minus({ hours: 1 });
    await db
      .update(duties)
      .set({
        data: {
          ...started.data,
          start: begun.toISO()!,
          end: begun.plus({ hours: 8 }).toISO()!,
        },
      })
      .where(eq(duties.id, d3));
    const preview = await command("duty.publish.preview", {
      dutyIds: [d1, d2, d3],
    });
    // By start time: the one that began an hour ago comes first.
    expect(preview.duties.map((row: { reason: string }) => row.reason)).toEqual(
      ["התורנות כבר התחילה", "התורנות כבר פורסמה", "התורנות בוטלה"]
    );
    expect(preview.duties.every((row: { ready: boolean }) => !row.ready)).toBe(
      true
    );
  });

  it("takes a duty named twice once, and refuses an unknown duty", async () => {
    const { d1 } = await threeDrafts(false);
    const preview = await command("duty.publish.preview", {
      dutyIds: [d1, d1],
    });
    expect(preview.duties).toHaveLength(1);
    await expect(
      command("duty.publish.preview", { dutyIds: [d1, randomUUID()] })
    ).rejects.toMatchObject({ code: "not_found", status: 404 });
  });

  it("is open to duty managers only", async () => {
    const { d1 } = await threeDrafts(false);
    const preview = await command("duty.publish.preview", { dutyIds: [d1] });
    for (const actor of [avi, technical]) {
      await expect(
        command("duty.publish.preview", { dutyIds: [d1] }, undefined, actor)
      ).rejects.toMatchObject({ code: "forbidden", status: 403 });
      await expect(
        command(
          "duty.publish.batch",
          { dutyIds: [d1], token: preview.token, confirmed: true },
          undefined,
          actor
        )
      ).rejects.toMatchObject({ code: "forbidden", status: 403 });
    }
    expect(await statuses(d1)).toEqual(["draft"]);
  });
});
