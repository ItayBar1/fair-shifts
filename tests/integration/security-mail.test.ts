import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db, pool } from "../../src/server/db";
import { user, authBudget, emailOutbox } from "../../src/server/auth-schema";
import {
  soldiers,
  balances,
  dutyTypes,
  duties,
  dutySlots,
  assignments,
  records,
} from "../../src/server/schema";
import {
  createInvitedAccount,
  type Actor,
} from "../../src/server/auth/accounts";
import { executeAction } from "../../src/server/actions";
import { createRecord, updateRecord } from "../../src/server/repository";
import { notifyManagers } from "../../src/server/seat-requests";
import {
  deliverNextEmail,
  enqueueEmail,
} from "../../src/server/operations/email";
import { quotaDay } from "../../src/server/operations/mail-quota-day";
import { soldier, duty, assignment } from "../fixtures";

if (
  !process.env.TEST_DATABASE_URL ||
  process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL ||
  !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test")
)
  throw new Error("Integration tests require a dedicated *_test database");

let serial: number;
async function person(
  role: "soldier" | "manager" = "soldier",
  released = false
) {
  const id = randomUUID();
  const number = ++serial;
  const name = `Synthetic ${number}`;
  await db.insert(soldiers).values({
    id,
    name,
    personalNumber: `890${String(number).padStart(4, "0")}`,
    data: soldier({
      id,
      name,
      service: {
        type: "mandatory",
        basePopulation: "mandatory",
        graceEligible: false,
        ...(released && {
          releaseDate: DateTime.now()
            .setZone("Asia/Jerusalem")
            .minus({ days: 1 })
            .toISODate()!,
        }),
      },
    }),
  });
  await db.insert(balances).values({ soldierId: id });
  return createInvitedAccount({
    name,
    role,
    soldierId: id,
    email: `mail-${number}@example.invalid`,
  });
}
const actor = (row: typeof user.$inferSelect): Actor => ({
  id: row.id,
  name: row.name,
  role: row.role as Actor["role"],
  soldierId: row.soldierId ?? undefined,
  securityEpoch: row.securityEpoch,
});
const act = (
  row: typeof user.$inferSelect,
  type: string,
  payload: unknown,
  expectedVersion = 1
) =>
  executeAction(actor(row), {
    type,
    payload,
    expectedVersion,
    idempotencyKey: randomUUID(),
  });
async function seat(personId: string, offset = 0) {
  const typeId = randomUUID(),
    id = randomUUID(),
    slotId = randomUUID(),
    seatId = randomUUID();
  const start = DateTime.now().plus({ days: 2, hours: offset }).toISO()!;
  const end = DateTime.fromISO(start).plus({ hours: 2 }).toISO()!;
  const data = {
    ...duty({
      id,
      typeId,
      start,
      end,
      status: "published",
      slots: [{ id: slotId, role: "תורן" }],
    }),
    location: "",
    instructions: "",
  };
  await db
    .insert(dutyTypes)
    .values({ id: typeId, name: "Synthetic", data: {} });
  await db.insert(duties).values({ id, typeId, name: data.name!, data });
  await db
    .insert(dutySlots)
    .values({ id: slotId, dutyId: id, data: { role: "תורן" } });
  await db.insert(assignments).values({
    id: seatId,
    dutyId: id,
    slotId,
    soldierId: personId,
    status: "reserved",
    points: 4,
    data: assignment({ id: seatId, dutyId: id, slotId, soldierId: personId }),
  });
  return seatId;
}
const request = async (id: string) =>
  (await db.select().from(records).where(eq(records.id, id)))[0];
const mails = () =>
  db.select().from(emailOutbox).where(eq(emailOutbox.kind, "transfer"));
async function workflow(
  owner: typeof user.$inferSelect,
  candidate: typeof user.$inferSelect,
  scope = "transfer"
) {
  return db.transaction((tx) =>
    createRecord(
      tx,
      "request",
      {
        type: scope,
        status: "awaiting_consent",
        fromSoldierId: owner.soldierId,
        candidates: [{ soldierId: candidate.soldierId, status: "pending" }],
      },
      owner.soldierId!
    )
  );
}
async function queue(
  row: typeof records.$inferSelect,
  recipient: typeof user.$inferSelect,
  event = "offer"
) {
  await db.transaction((tx) =>
    enqueueEmail(tx, {
      recipientAccountId: recipient.id,
      eventKey: `${row.data.type}:${row.id}:${event}:${recipient.id}`,
      kind: "transfer",
      title: "Synthetic",
      body: "Synthetic workflow mail",
      expiresAt: new Date(Date.now() + 86400_000),
    })
  );
}
beforeEach(async () => {
  await db.execute(
    sql`truncate table auth_user, auth_budget, auth_rate_limit, auth_verification, soldiers, duty_types, unit_lock, email_quota, operations_state, command_results cascade`
  );
  serial = 0;
});
afterAll(async () => pool.end());

describe("security #132: current management audience", () => {
  it("keeps old manager notices but creates none after demotion or release", async () => {
    const manager = await person("manager"),
      released = await person("manager", true);
    const id = randomUUID();
    await db.transaction((tx) => notifyManagers(tx, id, "First", "Synthetic"));
    await db
      .update(user)
      .set({ role: "soldier", securityEpoch: 2 })
      .where(eq(user.id, manager.id));
    await db.transaction((tx) => notifyManagers(tx, id, "Second", "Synthetic"));
    const notices = await db
      .select()
      .from(records)
      .where(eq(records.kind, "notification"));
    expect(
      notices
        .filter((row) => row.data.accountId === manager.id)
        .map((row) => row.data.title)
    ).toEqual(["First"]);
    expect(
      notices.filter((row) => row.data.accountId === released.id)
    ).toHaveLength(0);
  });

  it.each(["demotion", "release"] as const)(
    "cancels queued manager email after %s before delivery",
    async (change) => {
      const manager = await person("manager");
      await db.transaction((tx) =>
        enqueueEmail(tx, {
          recipientAccountId: manager.id,
          eventKey: randomUUID(),
          kind: "deletion",
          title: "Synthetic",
          body: "Synthetic management detail",
          expiresAt: new Date(Date.now() + 86400_000),
        })
      );
      if (change === "demotion")
        await db
          .update(user)
          .set({ role: "soldier" })
          .where(eq(user.id, manager.id));
      else {
        const [row] = await db
          .select()
          .from(soldiers)
          .where(eq(soldiers.id, manager.soldierId!));
        await db
          .update(soldiers)
          .set({
            data: {
              ...row.data,
              service: {
                ...row.data.service,
                releaseDate: DateTime.now()
                  .setZone("Asia/Jerusalem")
                  .minus({ days: 1 })
                  .toISODate()!,
              },
            },
          })
          .where(eq(soldiers.id, row.id));
      }
      let sent = 0;
      expect(
        await deliverNextEmail(
          async () => {
            sent++;
            return "synthetic";
          },
          new Date(Date.now() + 1000)
        )
      ).toEqual({ status: "skipped" });
      expect(sent).toBe(0);
      expect((await db.select().from(emailOutbox))[0]).toMatchObject({
        status: "cancelled",
        error: "recipient_unavailable",
      });
    }
  );
});

describe("security #132: workflow email relevance", () => {
  it.each(["transfer", "swap"])(
    "retains a valid manager rejection message for %s participants",
    async (scope) => {
      const owner = await person(),
        candidate = await person();
      const row = await workflow(owner, candidate, scope);
      await db.transaction((tx) =>
        updateRecord(tx, row, {
          ...row.data,
          status: "manager_rejected",
          acceptedBy: candidate.soldierId,
        })
      );
      await queue(row, owner, "rejected");
      await queue(row, candidate, "rejected");
      let sent = 0;
      for (let i = 0; i < 2; i++)
        expect(
          await deliverNextEmail(
            async () => {
              sent++;
              return "synthetic";
            },
            new Date(Date.now() + 1000)
          )
        ).toMatchObject({ status: "sent" });
      expect(sent).toBe(2);
    }
  );
  it("cancels old offers when completed but retains valid completion messages for both parties", async () => {
    const owner = await person(),
      candidate = await person(),
      stranger = await person();
    const row = await workflow(owner, candidate);
    await queue(row, candidate);
    await queue(row, owner, "completed");
    await db.transaction((tx) =>
      updateRecord(tx, row, {
        ...row.data,
        status: "completed",
        acceptedBy: candidate.soldierId,
      })
    );
    await queue(row, candidate, "completed");
    await queue(row, stranger, "completed");
    expect(
      (await mails()).find((mail) => mail.requestEvent === "offer")
    ).toMatchObject({ status: "cancelled", body: "" });
    const delivered: string[] = [];
    for (let i = 0; i < 3; i++)
      await deliverNextEmail(
        async (mail) => {
          delivered.push(mail.to);
          return "synthetic";
        },
        new Date(Date.now() + 1000)
      );
    expect(delivered.sort()).toEqual([owner.email, candidate.email].sort());
  });

  it("retains a swap offer while another seat for that recipient is pending, then cancels it", async () => {
    const owner = await person(),
      candidate = await person();
    const row = await workflow(owner, candidate, "swap");
    const candidates = [
      { soldierId: candidate.soldierId, status: "closed" },
      { soldierId: candidate.soldierId, status: "pending" },
    ];
    await queue(row, candidate);
    const updated = await db.transaction((tx) =>
      updateRecord(tx, row, { ...row.data, candidates })
    );
    expect((await mails())[0].status).toBe("pending");
    await db.transaction((tx) =>
      updateRecord(tx, updated, {
        ...updated.data,
        status: "expired",
        candidates: candidates.map((item) => ({ ...item, status: "closed" })),
      })
    );
    expect((await mails())[0].status).toBe("cancelled");
  });

  it("rechecks a historical pending offer even when it was closed without the command helper", async () => {
    const owner = await person(),
      candidate = await person();
    const row = await workflow(owner, candidate);
    await queue(row, candidate);
    await db
      .update(records)
      .set({ data: { ...row.data, status: "cancelled" } })
      .where(eq(records.id, row.id));
    let sent = 0;
    await deliverNextEmail(
      async () => {
        sent++;
        return "synthetic";
      },
      new Date(Date.now() + 1000)
    );
    expect(sent).toBe(0);
    expect((await mails())[0]).toMatchObject({
      status: "cancelled",
      error: "not_relevant",
    });
  });
});

describe("security #132: shared offer recipient budget", () => {
  it("saves proposals and site notices beyond 30 recipients, never refunds withdrawal, and shares the budget with swaps", async () => {
    const owner = await person();
    const candidates = await Promise.all(
      Array.from({ length: 20 }, () => person())
    );
    const owned = await seat(owner.soldierId!);
    const first = (await act(owner, "transfer.offer", {
      assignmentId: owned,
      candidateIds: candidates.map((row) => row.soldierId),
    })) as { id: string; version: number };
    await act(owner, "transfer.withdraw", { id: first.id }, first.version);
    const second = (await act(owner, "transfer.offer", {
      assignmentId: owned,
      candidateIds: candidates.map((row) => row.soldierId),
    })) as { id: string; version: number };
    expect((await request(second.id)).data.mailLimited).toBe(true);
    expect(await mails()).toHaveLength(30);
    const notices = await db
      .select()
      .from(records)
      .where(eq(records.kind, "notification"));
    expect(
      notices.filter(
        (row) =>
          row.data.requestId === second.id &&
          row.data.title === "הוצעה לך תורנות"
      )
    ).toHaveLength(20);
    await act(owner, "transfer.withdraw", { id: second.id }, second.version);
    const theirs = await seat(candidates[0].soldierId!, 5);
    const swap = (await act(owner, "swap.offer", {
      assignmentId: owned,
      targetAssignmentIds: [theirs],
    })) as { id: string };
    expect((await request(swap.id)).data.mailLimited).toBe(true);
    expect(await mails()).toHaveLength(30);
    expect(
      (
        await db
          .select()
          .from(authBudget)
          .where(
            and(
              eq(authBudget.category, "seat-offer:issue"),
              eq(authBudget.scope, `account:${owner.id}`)
            )
          )
      )[0].used
    ).toBe(30);
  });

  it("reserves the final recipient only once while both competing proposals remain saved", async () => {
    const owner = await person(),
      candidate = await person();
    const seats = await Promise.all([
      seat(owner.soldierId!),
      seat(owner.soldierId!, 5),
    ]);
    await db.insert(authBudget).values({
      day: quotaDay(new Date()),
      category: "seat-offer:issue",
      scope: `account:${owner.id}`,
      used: 29,
    });
    const results = (await Promise.all(
      seats.map((id) =>
        act(owner, "transfer.offer", {
          assignmentId: id,
          candidateIds: [candidate.soldierId],
        })
      )
    )) as { id: string }[];
    expect(await mails()).toHaveLength(1);
    expect(
      (await Promise.all(results.map((row) => request(row.id)))).filter(
        (row) => row.data.mailLimited
      )
    ).toHaveLength(1);
  });
});
