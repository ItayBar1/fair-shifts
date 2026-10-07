import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, pool } from "../../src/server/db";
import { user } from "../../src/server/auth-schema";
import {
  balances,
  duties,
  soldierContacts,
  soldiers,
} from "../../src/server/schema";
import {
  createInvitedAccount,
  type Actor,
} from "../../src/server/auth/accounts";
import { executeAction } from "../../src/server/actions";
import { errorResponse } from "../../src/server/http";
import { readState } from "../../src/server/state";
import { GET as readStateRoute } from "../../src/app/api/v1/state/route";
import { POST as actionRoute } from "../../src/app/api/v1/actions/route";
import { soldier } from "../fixtures";

if (
  !process.env.TEST_DATABASE_URL ||
  process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL ||
  !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test")
)
  throw new Error("Integration tests require a dedicated *_test database");

// Who may do what, for the soldier, the two managers and the technical account
// (story 60, scenarios 2, 3, 33, 45 and 57). Synthetic people only.
type Role = Actor["role"];
type Access = "manager" | "technical" | "staff" | "soldier" | "everyone";
const MANAGER = [
  "import.restore.preview",
  "import.restore",
  "import.preview",
  "import.get",
  "import.apply",
  "soldier.create",
  "soldier.update.preview",
  "soldier.update",
  "soldier.delete.preview",
  "soldier.delete",
  "soldier.timeline.preview",
  "soldier.timeline",
  "soldier.timeline.edit.preview",
  "soldier.timeline.edit",
  "soldier.conditions.preview",
  "soldier.conditions",
  "eligibility.catalog.save",
  "rank.catalog.save",
  "rank.rule.save",
  "rank.deadline",
  "rank.set",
  "rank.approve",
  "round.create",
  "round.close",
  "round.reopen",
  "constraint.preview",
  "constraint.review",
  "dutyType.save",
  "dutyType.impact.preview",
  "duty.create",
  "duty.assign",
  "duty.assignment.preview",
  "duty.lottery",
  "duty.lottery.approve",
  "planning.run",
  "planning.step",
  "duty.publish",
  "duty.publish.preview",
  "duty.publish.batch",
  "duty.change.create",
  "duty.change.save",
  "duty.change.rules",
  "duty.change.preview",
  "duty.change.publish",
  "duty.change.apply",
  "duty.change.discard",
  "duty.cancel",
  "cancellation.reject",
  "cancellation.refer",
  "cancellation.prepare",
  "score.preview",
  "score.apply",
  "performance.correction.preview",
  "performance.correction.apply",
  "execution.preview",
  "execution.apply",
  "score.decision.preview",
  "score.decision.apply",
  "manager.return.keep",
  "notification.defaults.save",
  "transfer.review",
  "transfer.decide",
  "swap.review",
  "swap.decide",
];
const access: Record<string, Access> = {
  ...Object.fromEntries(MANAGER.map((type) => [type, "manager" as Access])),
  // Only the technical account grants a role or asks for a backup (scenario 45).
  "account.role": "technical",
  "technical.user.create": "technical",
  "backup.request": "technical",
  // The technical account moves its own address with a code from each mailbox (decision 204).
  "technical.email.request": "technical",
  "technical.email.confirm": "technical",
  // A manager releases a soldier and the technical account a manager.
  "account.unlock": "staff",
  "account.responsibility": "staff",
  // A soldier's own requests; a manager takes no part in duties (decision 192).
  "constraint.submit": "soldier",
  "cancellation.submit": "soldier",
  "cancellation.withdraw": "soldier",
  "transfer.offer": "soldier",
  "transfer.respond": "soldier",
  "transfer.withdraw": "soldier",
  "swap.offer": "soldier",
  "swap.respond": "soldier",
  "swap.withdraw": "soldier",
  // The calendar belongs to a soldier; a manager takes no seat, so has none (decisions 192 and 195).
  "calendar.switch": "soldier",
  "calendar.remove.future": "soldier",
  // A manager changes a soldier's address, after the new one is verified (section 7.1).
  "account.email.request": "manager",
  "account.email.confirm": "manager",
  // Personal matters of whoever is signed in.
  "notification.read": "everyone",
  "notification.hide": "everyone",
  "settings.save": "everyone",
  "settings.reset": "everyone",
};
const allEmail = {
  roundOpening: true,
  roundClosing: true,
  publication: true,
  transfer: true,
  departure: true,
};
const permitted = (kind: Access, role: Role) =>
  kind === "everyone" ||
  kind === role ||
  (kind === "staff" && role !== "soldier");
const commands = [
  ...readFileSync("src/server/actions.ts", "utf8").matchAll(
    /case "([a-zA-Z.]+)":/g
  ),
].map((match) => match[1]);

let technical: Actor;
let manager: Actor;
let otherManager: Actor;
let alon: Actor;
let bar: Actor;
let serial = 100;
const actors = (): Record<Role, Actor> => ({
  soldier: alon,
  manager,
  technical,
});

async function invite(
  name: string,
  role: "soldier" | "manager",
  extra: { phone?: string; address?: string } = {}
): Promise<Actor> {
  const soldierId = randomUUID();
  const personalNumber = String(serial++).padStart(6, "0");
  const email = `${personalNumber}@example.invalid`;
  await db.insert(soldiers).values({
    id: soldierId,
    name,
    personalNumber,
    data: soldier({ id: soldierId, name, personalNumber }),
  });
  await db.insert(soldierContacts).values({ soldierId, email, ...extra });
  await db.insert(balances).values({ soldierId, current: 20 });
  const row = await createInvitedAccount({ name, role, email, soldierId });
  return { id: row.id, name, role, soldierId, securityEpoch: 1 };
}
async function send(
  actor: Actor,
  type: string,
  payload: Record<string, unknown> = {},
  expectedVersion?: number,
  idempotencyKey = randomUUID()
) {
  return (await executeAction(actor, {
    type,
    payload,
    expectedVersion,
    idempotencyKey,
  })) as { id: string; version: number } & Record<string, unknown>;
}
/** The answer the browser would get: 200 or the status of the error response. */
async function statusOf(promise: Promise<unknown>) {
  try {
    await promise;
    return { status: 200, code: undefined };
  } catch (error) {
    const response = errorResponse(error);
    const body = (await response.json()) as { error: { code: string } };
    return { status: response.status, code: body.error.code };
  }
}
async function accountOf(person: Actor) {
  const [row] = await db.select().from(user).where(eq(user.id, person.id));
  return row;
}

beforeEach(async () => {
  await db.execute(
    sql`truncate table auth_user, soldiers, duty_types, unit_lock, email_quota, operations_state, command_results cascade`
  );
  serial = 100;
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
  otherManager = await invite("אחראי שני", "manager");
  alon = await invite("אלון", "soldier", {
    phone: "050-1111111",
    address: "רחוב הבדיקה 7",
  });
  bar = await invite("בר", "soldier", {
    phone: "050-2222222",
    address: "שדרות הניסוי 9",
  });
});
afterAll(async () => pool.end());

describe("who may issue each command", () => {
  it("classifies every command the server knows, and no other", () => {
    expect(commands.length).toBeGreaterThan(75);
    expect(Object.keys(access).sort()).toEqual([...commands].sort());
  });
  it("refuses a role that the command is not for with 403, before reading the payload", async () => {
    const refused: string[] = [];
    for (const type of commands) {
      for (const [role, actor] of Object.entries(actors()) as [Role, Actor][]) {
        if (permitted(access[type], role)) continue;
        // A soldier's own requests answer 403 or 4xx; the rest answer 403 at once.
        const answer = await statusOf(send(actor, type, {}));
        if (access[type] === "soldier")
          expect(answer.status, `${role} ${type}`).toBeGreaterThanOrEqual(400);
        else if (answer.status !== 403)
          refused.push(`${role} ${type}: ${answer.status}`);
      }
    }
    expect(refused).toEqual([]);
  });
  it("lets each role reach the commands it is for, and never fails with a server error", async () => {
    const failures: string[] = [];
    for (const type of commands) {
      for (const [role, actor] of Object.entries(actors()) as [Role, Actor][]) {
        if (!permitted(access[type], role)) continue;
        const answer = await statusOf(send(actor, type, {}));
        if ([401, 403].includes(answer.status) || answer.status >= 500)
          failures.push(`${role} ${type}: ${answer.status} ${answer.code}`);
      }
    }
    expect(failures).toEqual([]);
  });
  it("answers an unknown command the same way to everyone", async () => {
    for (const actor of Object.values(actors()))
      expect(await statusOf(send(actor, "unit.shutdown"))).toEqual({
        status: 501,
        code: "not_implemented",
      });
  });
  it("asks for a fresh sign-in on every command when the account changed, before any role check", async () => {
    const stale = Object.values(actors()).map((actor) => ({
      ...actor,
      securityEpoch: actor.securityEpoch + 1,
    }));
    const unexpected: string[] = [];
    for (const type of commands)
      for (const actor of stale) {
        const answer = await statusOf(send(actor, type, {}));
        if (answer.status !== 401)
          unexpected.push(`${actor.role} ${type}: ${answer.status}`);
      }
    expect(unexpected).toEqual([]);
  });
  it("closes the doors on a locked account at once", async () => {
    await db
      .update(user)
      .set({ lockedAt: new Date() })
      .where(eq(user.id, manager.id));
    expect(
      await statusOf(send(manager, "dutyType.save", { name: "סוג" }))
    ).toMatchObject({ status: 401 });
    expect(await statusOf(readState(manager))).toMatchObject({ status: 401 });
  });
  it("sends a malformed envelope back as a validation error, not a failure", async () => {
    const bad = [
      { type: "", payload: {}, idempotencyKey: randomUUID() },
      { type: "duty.create", payload: "text", idempotencyKey: randomUUID() },
      { type: "duty.create", payload: {} },
      { type: "x".repeat(81), payload: {}, idempotencyKey: randomUUID() },
      { type: "duty.create", payload: {}, idempotencyKey: "not-a-uuid" },
      {
        type: "duty.create",
        payload: {},
        idempotencyKey: randomUUID(),
        expectedVersion: 0,
      },
    ];
    for (const envelope of bad)
      expect(
        await statusOf(executeAction(manager, envelope)),
        JSON.stringify(envelope)
      ).toMatchObject({ status: 422, code: "invalid_input" });
  });
});

describe("the API in front of the commands", () => {
  const origin = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
  const call = (route: typeof actionRoute, headers: Record<string, string>) =>
    route(
      new Request(`${origin}/api/v1/actions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ type: "duty.create", payload: {} }),
      })
    );
  it("turns an anonymous read away", async () => {
    const response = await readStateRoute(
      new Request(`${origin}/api/v1/state`)
    );
    expect(response.status).toBe(401);
    expect(
      ((await response.json()) as { error: { code: string } }).error.code
    ).toBe("unauthorized");
  });
  it("refuses a request from another origin, with or without a session", async () => {
    for (const headers of [
      {} as Record<string, string>,
      { origin: "https://elsewhere.example" },
    ]) {
      const response = await call(actionRoute, headers);
      expect(response.status).toBe(403);
      expect(
        ((await response.json()) as { error: { code: string } }).error.code
      ).toBe("forbidden_origin");
    }
  });
  it("turns an anonymous command from the right origin away", async () => {
    const response = await call(actionRoute, { origin });
    expect(response.status).toBe(401);
  });
});

describe("what each role is shown", () => {
  it("shows an empty unit to everyone without an error", async () => {
    for (const [role, actor] of Object.entries(actors()) as [Role, Actor][]) {
      const state = (await readState(actor)) as Record<string, unknown>;
      expect(state.actor).toMatchObject({ id: actor.id, role });
      for (const list of [
        "duties",
        "assignments",
        "rounds",
        "requests",
        "ledger",
        "notifications",
        "dutyTypes",
      ])
        expect(state[list], `${role} ${list}`).toEqual([]);
      expect(state.settings).toMatchObject({ source: "system" });
    }
  });
  it("gives the technical account accounts and operations but no soldiers or scores", async () => {
    const state = (await readState(technical)) as Record<string, unknown>;
    expect(state.soldiers).toEqual([]);
    expect(state.ledger).toEqual([]);
    expect((state.accounts as unknown[]).length).toBe(5);
    expect(state).toHaveProperty("health");
    expect(await readState(alon)).not.toHaveProperty("health");
    expect(await readState(manager)).not.toHaveProperty("health");
  });
  it("keeps contact details out of every state but a manager's", async () => {
    const secrets = [
      "050-1111111",
      "רחוב הבדיקה 7",
      "050-2222222",
      "שדרות הניסוי 9",
    ];
    const emails = (await db.select().from(soldierContacts)).map(
      (row) => row.email
    );
    for (const actor of [alon, bar, technical]) {
      const text = JSON.stringify(await readState(actor));
      for (const value of [...secrets, ...emails])
        expect(text, `${actor.role} sees ${value}`).not.toContain(value);
    }
    // The same text does reach a manager, so the check above can fail.
    const managed = JSON.stringify(await readState(manager));
    for (const value of secrets) expect(managed).toContain(value);
  });
  it("keeps another soldier's exemptions and hours out of a soldier's state", async () => {
    const [row] = await db
      .select()
      .from(soldiers)
      .where(eq(soldiers.id, bar.soldierId!));
    await db
      .update(soldiers)
      .set({
        data: {
          ...row.data,
          exemptions: [
            {
              exemptionId: "exempt-private",
              start: "2026-01-01",
              end: "2026-12-31",
            },
          ],
          gender: "female",
          capabilities: ["capability-private"],
        },
      })
      .where(eq(soldiers.id, bar.soldierId!));
    const own = JSON.stringify(await readState(alon));
    for (const hidden of ["exempt-private", "capability-private", "female"])
      expect(own).not.toContain(hidden);
    expect(JSON.stringify(await readState(manager))).toContain(
      "exempt-private"
    );
  });
  it("shows both managers the same unit, with a draft that only managers see", async () => {
    const kind = await send(manager, "dutyType.save", {
      name: "סוג משותף",
      pricing: { mode: "fixed", base: 4 },
      roles: [{ name: "תורן", count: 1 }],
    });
    const start = Date.now() + 3 * 86_400_000;
    const created = await send(manager, "duty.create", {
      typeId: kind.id,
      name: "טיוטה משותפת",
      start: new Date(start).toISOString(),
      end: new Date(start + 8 * 3_600_000).toISOString(),
    });
    const names = async (actor: Actor) =>
      ((await readState(actor)).duties as { id: string }[]).map(
        (row) => row.id
      );
    expect(await names(manager)).toEqual([created.id]);
    expect(await names(otherManager)).toEqual([created.id]);
    expect(await names(alon)).toEqual([]);
    expect(await names(technical)).toEqual([]);
    expect(
      ((await readState(otherManager)).soldiers as { id: string }[])
        .map((row) => row.id)
        .sort()
    ).toEqual(
      ((await readState(manager)).soldiers as { id: string }[])
        .map((row) => row.id)
        .sort()
    );
  });
});

describe("a version that changed", () => {
  it("makes the second of two managers read again before saving a soldier", async () => {
    const [row] = await db
      .select()
      .from(soldiers)
      .where(eq(soldiers.id, bar.soldierId!));
    const edit = (actor: Actor, name: string, version?: number) =>
      send(
        actor,
        "soldier.update",
        { id: bar.soldierId, name, personalNumber: row.personalNumber },
        version
      );
    const first = await edit(manager, "בר א", row.version);
    expect(first.version).toBe(row.version + 1);
    expect(await statusOf(edit(otherManager, "בר ב", row.version))).toEqual({
      status: 409,
      code: "stale_version",
    });
    expect(await statusOf(edit(otherManager, "בר ג"))).toMatchObject({
      status: 409,
    });
    expect((await edit(otherManager, "בר ב", first.version)).version).toBe(
      first.version + 1
    );
  });
  it("makes a manager read the duty again after another manager changed it", async () => {
    const kind = await send(manager, "dutyType.save", {
      name: "סוג לגרסה",
      pricing: { mode: "fixed", base: 4 },
      roles: [{ name: "תורן", count: 1 }],
    });
    const start = Date.now() + 3 * 86_400_000;
    const created = await send(manager, "duty.create", {
      typeId: kind.id,
      name: "תורנות לגרסה",
      start: new Date(start).toISOString(),
      end: new Date(start + 8 * 3_600_000).toISOString(),
    });
    const [row] = await db
      .select()
      .from(duties)
      .where(eq(duties.id, created.id));
    const slotId = row.data.slots[0].id;
    await send(
      manager,
      "duty.assign",
      { dutyId: row.id, slotId, soldierId: alon.soldierId },
      row.version
    );
    expect(
      await statusOf(
        send(
          otherManager,
          "duty.publish",
          { id: row.id, confirmed: true },
          row.version
        )
      )
    ).toEqual({ status: 409, code: "stale_version" });
  });
  it("makes a soldier read the form again after the preferences changed", async () => {
    const form = {
      reminders: [{ hours: 3, email: true, calendar: true }],
      email: allEmail,
    };
    const saved = await send(alon, "settings.save", form);
    expect(await statusOf(send(alon, "settings.save", form))).toMatchObject({
      status: 409,
    });
    const next = await send(alon, "settings.save", form, saved.version);
    expect(next.version).toBeGreaterThan(saved.version);
    expect(
      await statusOf(send(alon, "settings.save", form, saved.version))
    ).toEqual({ status: 409, code: "stale_version" });
  });
  it("makes the technical account read the account again before changing a role", async () => {
    const row = await accountOf(bar);
    const promote = (version?: number) =>
      send(technical, "account.role", { id: bar.id, role: "manager" }, version);
    expect(await statusOf(promote())).toMatchObject({ status: 409 });
    expect(await statusOf(promote(row.securityEpoch + 5))).toMatchObject({
      status: 409,
    });
    await promote(row.securityEpoch);
    expect((await accountOf(bar)).role).toBe("manager");
  });
});
