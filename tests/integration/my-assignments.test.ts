import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, pool, unitTransaction } from "../../src/server/db";
import {
  assignments,
  assignmentMailWindow,
  balances,
  duties,
  dutySlots,
  dutyTypes,
  soldiers,
} from "../../src/server/schema";
import { emailOutbox } from "../../src/server/auth-schema";
import {
  createInvitedAccount,
  type Actor,
} from "../../src/server/auth/accounts";
import { readMyAssignments } from "../../src/server/my-assignments";
import { deliverNextEmail } from "../../src/server/operations/email";
import {
  previewPublishDrafts,
  publishDrafts,
} from "../../src/server/duty-publishing";
import { assignment, duty, soldier } from "../fixtures";

if (
  !process.env.TEST_DATABASE_URL ||
  process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL ||
  !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test")
)
  throw new Error("Integration tests require a dedicated *_test database");

async function person(role: Actor["role"] = "soldier"): Promise<Actor> {
  const soldierId = role === "technical" ? undefined : randomUUID();
  const name = `בדיקה ${role}`;
  const email = `${randomUUID()}@example.invalid`;
  if (soldierId) {
    await db.insert(soldiers).values({
      id: soldierId,
      name,
      personalNumber: randomUUID(),
      data: soldier({ id: soldierId, name }),
    });
    await db.insert(balances).values({ soldierId });
  }
  const row = await createInvitedAccount({ name, role, email, soldierId });
  return { id: row.id, name, role, soldierId, securityEpoch: 1 };
}
async function makeDuty(actor: Actor, published = false, daysAhead = 2) {
  const typeId = randomUUID(),
    dutyId = randomUUID(),
    slotId = randomUUID(),
    assignmentId = randomUUID();
  const start = new Date(Date.now() + daysAhead * 86400_000).toISOString();
  const end = new Date(Date.now() + (daysAhead + 1) * 86400_000).toISOString();
  const data = {
    ...duty({
      id: dutyId,
      typeId,
      start,
      end,
      slots: [{ id: slotId, role: "תורן שער" }],
    }),
    name: "שמירת שער",
    location: "שער ראשי",
    instructions: "",
  };
  await db
    .insert(dutyTypes)
    .values({ id: typeId, name: "סוג בדיקה", data: {} });
  await db.insert(duties).values({ id: dutyId, typeId, name: data.name, data });
  await db
    .insert(dutySlots)
    .values({ id: slotId, dutyId, data: { role: "תורן שער" } });
  const seat = assignment({
    id: assignmentId,
    dutyId,
    slotId,
    soldierId: actor.soldierId!,
  });
  await db.insert(assignments).values({ ...seat, data: seat });
  if (published) await publish(dutyId);
  return { dutyId, assignmentId };
}
async function publish(dutyId: string) {
  const [row] = await db.select().from(duties).where(eq(duties.id, dutyId));
  await db
    .update(duties)
    .set({
      data: {
        ...row.data,
        status: "published",
        publishedAt: new Date().toISOString(),
      },
      version: row.version + 1,
    })
    .where(eq(duties.id, dutyId));
}
beforeEach(async () => {
  await db.execute(
    sql`truncate table auth_user, soldiers, duty_types, unit_lock, email_quota, operations_state, command_results cascade`
  );
});
afterAll(async () => pool.end());

describe("private assignment feed", () => {
  it("records batch publication and highlights every duty in the recipient's mail", async () => {
    const actor = await person();
    const manager = await person("manager");
    const first = await makeDuty(actor);
    const second = await makeDuty(actor, false, 4);
    const dutyIds = [first.dutyId, second.dutyId];
    expect((await readMyAssignments(actor)).current).toEqual([]);
    const preview = await unitTransaction((tx) =>
      previewPublishDrafts(tx, manager, { dutyIds })
    );
    expect(preview.ready).toBe(2);
    await unitTransaction((tx) =>
      publishDrafts(tx, manager, {
        dutyIds,
        token: preview.token,
        confirmed: true,
      })
    );
    expect((await readMyAssignments(actor)).current).toMatchObject([
      { dutyId: first.dutyId, badge: "new" },
      { dutyId: second.dutyId, badge: "new" },
    ]);
    const [window] = await db.select().from(assignmentMailWindow);
    const result = await deliverNextEmail(
      async () => "synthetic-delivery",
      new Date(window.closesAt.getTime() + 60_000)
    );
    expect(result.status).toBe("sent");
    const mailId = window.id;
    const [mail] = await db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.id, mailId));
    expect(mail.dutyIds.sort()).toEqual(dutyIds.sort());
    expect((await readMyAssignments(actor, mailId)).current).toMatchObject([
      { dutyId: first.dutyId, highlighted: true, badge: undefined },
      { dutyId: second.dutyId, highlighted: true, badge: undefined },
    ]);
  });
  it("records publication, advances the cursor once, and keeps later events for another window", async () => {
    const actor = await person();
    const firstDuty = await makeDuty(actor);
    expect((await readMyAssignments(actor)).current).toEqual([]); // draft
    await publish(firstDuty.dutyId);
    const first = await readMyAssignments(actor);
    expect(first.current).toMatchObject([
      { dutyId: firstDuty.dutyId, badge: "new", role: "תורן שער" },
    ]);
    const secondDuty = await makeDuty(actor, true);
    const second = await readMyAssignments(actor);
    expect(
      second.current.find((item) => item.dutyId === firstDuty.dutyId)?.badge
    ).toBeUndefined();
    expect(
      second.current.find((item) => item.dutyId === secondDuty.dutyId)?.badge
    ).toBe("new");
    expect(
      (await readMyAssignments(actor)).current.every((item) => !item.badge)
    ).toBe(true);
  });
  it("records changed duty details and removal, then clears the cancelled section on revisit", async () => {
    const actor = await person();
    const { dutyId, assignmentId } = await makeDuty(actor, true);
    await readMyAssignments(actor);
    const [row] = await db.select().from(duties).where(eq(duties.id, dutyId));
    await db
      .update(duties)
      .set({ name: "שער מעודכן", data: { ...row.data, name: "שער מעודכן" } })
      .where(eq(duties.id, dutyId));
    expect((await readMyAssignments(actor)).current[0]).toMatchObject({
      name: "שער מעודכן",
      badge: "updated",
    });
    const [seat] = await db
      .select()
      .from(assignments)
      .where(eq(assignments.id, assignmentId));
    await db
      .update(assignments)
      .set({ status: "cancelled", data: { ...seat.data, status: "cancelled" } })
      .where(eq(assignments.id, assignmentId));
    expect((await readMyAssignments(actor)).cancelled).toMatchObject([
      { dutyId, role: "תורן שער" },
    ]);
    expect((await readMyAssignments(actor)).cancelled).toEqual([]);
    const mailId = randomUUID();
    await db.insert(emailOutbox).values({
      id: mailId,
      recipientAccountId: actor.id,
      eventKey: randomUUID(),
      kind: "publication-change",
      title: "בוטל",
      body: "בוטל",
      dutyIds: [dutyId],
      expiresAt: new Date(Date.now() + 86400_000),
    });
    expect((await readMyAssignments(actor, mailId)).cancelled).toMatchObject([
      { dutyId, highlighted: true },
    ]);
  });
  it("highlights mail items only for their recipient and blocks technical and manager without history", async () => {
    const actor = await person();
    const other = await person();
    const technical = await person("technical");
    const manager = await person("manager");
    const { dutyId } = await makeDuty(actor, true);
    const mailId = randomUUID();
    await db.insert(emailOutbox).values({
      id: mailId,
      recipientAccountId: actor.id,
      eventKey: randomUUID(),
      kind: "publication",
      title: "בדיקה",
      body: "בדיקה",
      dutyIds: [dutyId],
      expiresAt: new Date(Date.now() + 86400_000),
    });
    expect(
      (await readMyAssignments(actor, mailId)).current[0].highlighted
    ).toBe(true);
    expect((await readMyAssignments(other, mailId)).current).toEqual([]);
    expect(
      (await readMyAssignments(actor, randomUUID())).current[0].highlighted
    ).toBe(false);
    expect(
      (await readMyAssignments(actor, "bad-id")).current[0].highlighted
    ).toBe(false);
    await expect(readMyAssignments(technical)).rejects.toMatchObject({
      status: 403,
    });
    await expect(readMyAssignments(manager)).rejects.toMatchObject({
      status: 403,
    });
    const historical = await makeDuty(manager, true);
    expect((await readMyAssignments(manager)).current).toMatchObject([
      { dutyId: historical.dutyId },
    ]);
  });
});
