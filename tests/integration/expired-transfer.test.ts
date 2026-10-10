import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, pool, unitTransaction } from "../../src/server/db";
import {
  assignments,
  balances,
  duties,
  dutySlots,
  dutyTypes,
  ledger,
  records,
  soldiers,
} from "../../src/server/schema";
import {
  createInvitedAccount,
  type Actor,
} from "../../src/server/auth/accounts";
import { executeAction } from "../../src/server/actions";
import { errorResponse } from "../../src/server/http";
import { settleDue } from "../../src/server/scoring";
import { assignment, duty, soldier } from "../fixtures";

if (
  !process.env.TEST_DATABASE_URL ||
  process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL ||
  !new URL(process.env.DATABASE_URL).pathname.endsWith("_test")
)
  throw new Error("Integration tests require a dedicated *_test database");
let from: Actor;
let to: Actor;
let manager: Actor;
let clock: number;
let start: number;
const stamp = (value: number) => new Date(value).toISOString();
async function invite(
  number: string,
  role: "soldier" | "manager" = "soldier"
): Promise<Actor> {
  const soldierId = randomUUID();
  const name = `Synthetic ${number}`;
  await db.insert(soldiers).values({
    id: soldierId,
    name,
    personalNumber: number,
    data: soldier({ id: soldierId, name, personalNumber: number }),
  });
  await db.insert(balances).values({ soldierId });
  const account = await createInvitedAccount({
    name,
    role,
    email: `${number}@example.invalid`,
    soldierId,
  });
  return {
    id: account.id,
    name,
    role,
    soldierId,
    securityEpoch: account.securityEpoch,
  };
}
async function command(
  actor: Actor,
  type: string,
  payload: Record<string, unknown>,
  version = 1,
  key = randomUUID()
) {
  return (await executeAction(actor, {
    type,
    payload,
    expectedVersion: version,
    idempotencyKey: key,
  })) as { id: string; version: number; status?: string };
}
async function seatFor(actor: Actor, offset = 0, partial = false) {
  const typeId = randomUUID();
  const dutyId = randomUUID();
  const slotId = randomUUID();
  const data = duty({
    id: dutyId,
    typeId,
    status: "published",
    rulesVersion: 1,
    start: stamp(start + 60_000 + offset),
    end: stamp(start + (partial ? 240_000 : 120_000) + offset),
    slots: [{ id: slotId, role: "Synthetic" }],
  });
  await db
    .insert(dutyTypes)
    .values({ id: typeId, name: "Synthetic", data: {} });
  await db.insert(duties).values({
    id: dutyId,
    typeId,
    name: "Synthetic",
    data: { ...data, location: "", instructions: "" },
  });
  await db
    .insert(dutySlots)
    .values({ id: slotId, dutyId, data: { role: "Synthetic" } });
  const seat = assignment({
    id: randomUUID(),
    dutyId,
    slotId,
    soldierId: actor.soldierId!,
    ...(partial && {
      performedStart: data.start,
      performedEnd: stamp(start + 120_000 + offset),
    }),
  });
  await db.insert(assignments).values({ ...seat, data: seat });
  return seat;
}
async function request(id: string) {
  const [row] = await db.select().from(records).where(eq(records.id, id));
  return row;
}
async function setup(
  kind: "transfer" | "swap",
  partial = false,
  targetEndsFirst = false
) {
  const seat = await seatFor(from, targetEndsFirst ? 300_000 : 0, partial);
  const target =
    kind === "swap"
      ? await seatFor(to, targetEndsFirst ? 0 : 300_000)
      : undefined;
  const offered = await command(from, `${kind}.offer`, {
    assignmentId: seat.id,
    ...(target
      ? { targetAssignmentIds: [target.id] }
      : { candidateIds: [to.soldierId] }),
  });
  const accept = (version = offered.version, key = randomUUID()) =>
    command(
      to,
      `${kind}.respond`,
      {
        id: offered.id,
        decision: "accept",
        confirmed: true,
        ...(target && { assignmentId: target.id }),
      },
      version,
      key
    );
  return { seat, target, offered, accept };
}
async function businessError(action: () => Promise<unknown>) {
  let caught: unknown;
  try {
    await action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeDefined();
  const response = errorResponse(caught);
  const body = await response.json();
  expect(response.status).toBe(409);
  expect(body.error.code).toBe("performance_ended");
  expect(body.error.message).toMatch(/[א-ת]/);
}
beforeEach(async () => {
  await db.execute(
    sql`truncate table auth_user, soldiers, duty_types, unit_lock, email_quota, operations_state, command_results cascade`
  );
  from = await invite("990021");
  to = await invite("990022");
  manager = await invite("990023", "manager");
  start = Date.now();
  clock = start;
  vi.spyOn(Date, "now").mockImplementation(() => clock);
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => pool.end());

describe.each(["transfer", "swap"] as const)(
  "expired %s execution with a delayed worker (#117)",
  (kind) => {
    it.each([0, 1, 1000])(
      "expires acceptance at or after the execution end (+%i ms) without HTTP 500",
      async (offset) => {
        const { offered, accept } = await setup(kind);
        const seatsBefore = await db.select().from(assignments);
        clock = start + 120_000 + offset;
        const key = randomUUID();
        await businessError(() => accept(offered.version, key));
        expect((await request(offered.id)).data.status).toBe("expired");
        await businessError(() => accept(offered.version, key));
        expect(await db.select().from(assignments)).toEqual(seatsBefore);
        expect(await db.select().from(ledger)).toEqual([]);
        expect(
          await unitTransaction((tx) =>
            settleDue(tx, new Date(start + 1_000_000))
          )
        ).toBe(seatsBefore.length);
        expect(
          await unitTransaction((tx) =>
            settleDue(tx, new Date(start + 1_000_000))
          )
        ).toBe(0);
        expect(
          (await db.select().from(ledger)).filter(
            (row) => row.kind === "performance"
          )
        ).toHaveLength(seatsBefore.length);
      }
    );
    it("routes consent one millisecond before the end to the manager and keeps the original seat", async () => {
      const { offered, accept } = await setup(kind);
      const before = await db.select().from(assignments);
      clock = start + 119_999;
      await accept();
      expect((await request(offered.id)).data.status).toBe("awaiting_manager");
      expect(await db.select().from(assignments)).toEqual(before);
      const row = await request(offered.id);
      expect(
        await command(
          manager,
          `${kind}.review`,
          { id: offered.id },
          row.version
        )
      ).toMatchObject({ valid: true, handoverRequired: true });
    });
    it.each(["review", "approve", "reject"] as const)(
      "expires a manager %s after consent while execution was still active",
      async (stage) => {
        const { offered, accept } = await setup(kind);
        clock = start + 90_000;
        await accept();
        const row = await request(offered.id);
        const before = await db.select().from(assignments);
        clock = start + 120_000;
        await businessError(() =>
          command(
            manager,
            `${kind}.${stage === "review" ? "review" : "decide"}`,
            {
              id: offered.id,
              ...(stage === "approve" && {
                decision: "approve",
                confirmed: true,
                previewToken: "stale-preview",
              }),
              ...(stage === "reject" && {
                decision: "reject",
                reason: "בדיקה",
              }),
            },
            row.version
          )
        );
        expect((await request(offered.id)).data.status).toBe("expired");
        expect(await db.select().from(assignments)).toEqual(before);
      }
    );
    it("rejects a new offer exactly at its execution end with a Hebrew 409", async () => {
      const seat = await seatFor(from);
      const target = kind === "swap" ? await seatFor(to, 300_000) : undefined;
      clock = start + 120_000;
      await businessError(() =>
        command(from, `${kind}.offer`, {
          assignmentId: seat.id,
          ...(target
            ? { targetAssignmentIds: [target.id] }
            : { candidateIds: [to.soldierId] }),
        })
      );
      expect(
        (await db.select().from(records)).filter((r) => r.kind === "request")
      ).toEqual([]);
    });
    it("expires at the performer's own end even while the full duty continues", async () => {
      const { offered, accept } = await setup(kind, true);
      clock = start + 120_000;
      await businessError(() => accept());
      expect((await request(offered.id)).data.status).toBe("expired");
    });
  }
);

describe("swap target execution expiry", () => {
  it.each(["respond", "review", "approve"] as const)(
    "expires %s when the target's period ends first",
    async (stage) => {
      const { offered, accept } = await setup("swap", false, true);
      if (stage !== "respond") {
        clock = start + 90_000;
        await accept();
      }
      const row = await request(offered.id);
      clock = start + 120_000;
      await businessError(() =>
        stage === "respond"
          ? accept()
          : command(
              manager,
              `swap.${stage === "review" ? "review" : "decide"}`,
              {
                id: offered.id,
                ...(stage === "approve" && {
                  decision: "approve",
                  confirmed: true,
                  previewToken: "stale-preview",
                }),
              },
              row.version
            )
      );
      expect((await request(offered.id)).data.status).toBe("expired");
    }
  );
  it("closes only an expired target and retains other pending seats", async () => {
    const seat = await seatFor(from, 300_000);
    const ended = await seatFor(to);
    const later = await seatFor(to, 600_000);
    const offered = await command(from, "swap.offer", {
      assignmentId: seat.id,
      targetAssignmentIds: [ended.id, later.id],
    });
    clock = start + 120_000;
    await businessError(() =>
      command(to, "swap.respond", {
        id: offered.id,
        assignmentId: ended.id,
        decision: "accept",
        confirmed: true,
      })
    );
    const row = await request(offered.id);
    expect(row.data.status).toBe("awaiting_consent");
    expect(row.data.candidates).toMatchObject([
      { assignmentId: ended.id, status: "closed" },
      { assignmentId: later.id, status: "pending" },
    ]);
    expect(
      await command(
        to,
        "swap.respond",
        {
          id: offered.id,
          assignmentId: later.id,
          decision: "accept",
          confirmed: true,
        },
        row.version
      )
    ).toMatchObject({ status: "completed" });
  });
});
