import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, pool } from "../../src/server/db";
import { user, emailOutbox } from "../../src/server/auth-schema";
import { soldiers, soldierContacts, balances } from "../../src/server/schema";
import {
  createInvitedAccount,
  type Actor,
} from "../../src/server/auth/accounts";
import { requestCode, verifyCode } from "../../src/server/auth/otp";
import {
  openSecret,
  deliverNextEmail,
} from "../../src/server/operations/email";
import { executeAction } from "../../src/server/actions";
import { soldier } from "../fixtures";

if (
  !process.env.TEST_DATABASE_URL ||
  process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL ||
  !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test")
)
  throw new Error("Integration tests require a dedicated *_test database");

let manager: Actor;
beforeEach(async () => {
  await db.execute(
    sql`truncate table auth_user, auth_budget, auth_rate_limit, soldiers, duty_types, unit_lock, email_quota, operations_state, command_results cascade`
  );
  const id = randomUUID();
  const data = soldier({ id, name: "אחראי הזמנות", personalNumber: "0000001" });
  await db
    .insert(soldiers)
    .values({ id, name: data.name, personalNumber: data.personalNumber, data });
  await db
    .insert(soldierContacts)
    .values({ soldierId: id, email: "invitations-manager@example.invalid" });
  await db.insert(balances).values({ soldierId: id });
  const account = await createInvitedAccount({
    name: data.name,
    email: "invitations-manager@example.invalid",
    role: "manager",
    soldierId: id,
  });
  manager = {
    id: account.id,
    name: account.name,
    role: "manager",
    soldierId: id,
    securityEpoch: 1,
  };
});
afterAll(async () => pool.end());

type Batch = {
  id: string;
  version: number;
  invitationsStatus: string;
  invitationsQueued: number;
  invitationsSkipped: number;
  status: string;
  token: string;
};
const command = async (
  type: string,
  payload: Record<string, unknown>,
  expectedVersion?: number,
  idempotencyKey: string = randomUUID()
) =>
  (await executeAction(manager, {
    type,
    payload,
    expectedVersion,
    idempotencyKey,
  })) as Batch;
async function intake(
  extraRows: { rowNumber: number; values: Record<string, unknown> }[] = []
) {
  const preview = await command("import.preview", {
    filename: "synthetic.xlsx",
    rows: [
      {
        rowNumber: 2,
        values: {
          personalNumber: "0000002",
          name: "חייל הזמנה",
          email: "imported@example.invalid",
          currentScore: 3,
        },
      },
      ...extraRows,
    ],
  });
  return command(
    "import.apply",
    {
      id: preview.id,
      confirmed: true,
      overwriteConfirmed: true,
      reason: "קליטה סינתטית",
    },
    preview.version
  );
}
async function invitations() {
  return db
    .select()
    .from(emailOutbox)
    .where(eq(emailOutbox.kind, "invitation"));
}
const publish = (batch: Batch, key?: string) =>
  command(
    "import.invitations.publish",
    { id: batch.id, confirmed: true },
    batch.version,
    key
  );

describe("deferred import invitations (decision 219)", () => {
  it("stores soldiers and permits sign-in before any invitation is published", async () => {
    const batch = await intake();
    expect(batch.invitationsStatus).toBe("unpublished");
    expect(await invitations()).toHaveLength(0);
    const [account] = await db
      .select()
      .from(user)
      .where(eq(user.email, "imported@example.invalid"));
    expect(account.role).toBe("soldier");
    const [balance] = await db
      .select()
      .from(balances)
      .where(eq(balances.soldierId, account.soldierId!));
    expect(balance.current).toBe(3);
    await requestCode(account.email);
    const [message] = await db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.recipientAccountId, account.id));
    expect(message.kind).toBe("login-code");
    const code = openSecret(message.encryptedSecret!, {
      purpose: "mail-code",
      recordId: message.id,
    });
    expect((await verifyCode(account.email, code)).user?.id).toBe(account.id);
    expect(await invitations()).toHaveLength(0);
  });

  it("requires confirmation and publishes only new accounts once across two tabs and retries", async () => {
    const batch = await intake([
      {
        rowNumber: 3,
        values: { personalNumber: "0000001", name: "אחראי מעודכן" },
      },
    ]);
    await expect(
      command(
        "import.invitations.publish",
        { id: batch.id, confirmed: false },
        batch.version
      )
    ).rejects.toThrow();
    expect(await invitations()).toHaveLength(0);
    const key = randomUUID();
    const secondKey = randomUUID();
    const outcomes = await Promise.allSettled([
      publish(batch, key),
      publish(batch, secondKey),
    ]);
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled")
    ).toHaveLength(1);
    expect(
      outcomes.filter((outcome) => outcome.status === "rejected")
    ).toHaveLength(1);
    const saved = await command("import.get", { id: batch.id });
    expect(saved).toMatchObject({
      invitationsStatus: "published",
      invitationsQueued: 1,
      invitationsSkipped: 0,
    });
    const mail = await invitations();
    expect(mail).toHaveLength(1);
    expect(mail[0].expiresAt.getTime() - Date.now()).toBeGreaterThan(
      86_000_000
    );
    if (outcomes[0].status === "fulfilled")
      expect(await publish(batch, key)).toEqual(outcomes[0].value);
    if (outcomes[1].status === "fulfilled")
      expect(await publish(batch, secondKey)).toEqual(outcomes[1].value);
    await expect(publish(saved)).rejects.toMatchObject({
      code: "invitations_not_unpublished",
    });
    expect(await invitations()).toHaveLength(1);
  });

  it("uses the current account and skips an account erased before publication", async () => {
    const batch = await intake([
      {
        rowNumber: 3,
        values: {
          personalNumber: "0000003",
          name: "למחיקה",
          email: "erased@example.invalid",
        },
      },
    ]);
    const [account] = await db
      .select()
      .from(user)
      .where(eq(user.email, "imported@example.invalid"));
    await db
      .update(user)
      .set({ email: "updated@example.com" })
      .where(eq(user.id, account.id));
    await db
      .update(soldierContacts)
      .set({ email: "updated@example.com" })
      .where(eq(soldierContacts.soldierId, account.soldierId!));
    const [erased] = await db
      .select()
      .from(user)
      .where(eq(user.email, "erased@example.invalid"));
    await db
      .update(soldiers)
      .set({ deletedAt: new Date() })
      .where(eq(soldiers.id, erased.soldierId!));
    const published = await publish(batch);
    expect(published).toMatchObject({
      invitationsQueued: 1,
      invitationsSkipped: 1,
    });
    expect(await invitations()).toMatchObject([
      { recipientAccountId: account.id, destination: null },
    ]);
    // Destination is resolved from the current account at delivery, never the import snapshot.
    expect(JSON.stringify(await invitations())).not.toContain(
      "imported@example.invalid"
    );
    const delivered: string[] = [];
    await deliverNextEmail(async (message) => {
      delivered.push(message.to);
      return "synthetic-provider-id";
    });
    expect(delivered).toEqual(["updated@example.com"]);
  });

  it("does not revive invitations for a fully restored intake", async () => {
    const batch = await intake();
    const preview = await command(
      "import.restore.preview",
      { id: batch.id },
      batch.version
    );
    const restored = await command(
      "import.restore",
      {
        id: batch.id,
        token: preview.token,
        confirmed: true,
        reason: "קובץ סינתטי שגוי",
      },
      batch.version
    );
    expect(restored.status).toBe("restored");
    await expect(publish(restored)).rejects.toMatchObject({
      code: "invitations_not_unpublished",
    });
    expect(await invitations()).toHaveLength(0);
    expect(
      await db
        .select()
        .from(user)
        .where(eq(user.email, "imported@example.invalid"))
    ).toHaveLength(0);
  });

  it("cannot republish historical batches that used automatic invitations", async () => {
    const batch = await intake();
    await db.execute(
      sql`update records set data = data - 'invitationsStatus' where id = ${batch.id}`
    );
    await expect(publish(batch)).rejects.toMatchObject({
      code: "invitations_not_unpublished",
    });
    expect(await invitations()).toHaveLength(0);
  });

  it("keeps manual intake invitations automatic and needs none for an update-only batch", async () => {
    await command("soldier.create", {
      name: "קליטה ידנית",
      personalNumber: "0000004",
      email: "manual@example.invalid",
      population: "mandatory",
      serviceType: "mandatory",
      graceEligible: false,
    });
    expect(await invitations()).toHaveLength(1);
    const preview = await command("import.preview", {
      filename: "update.xlsx",
      rows: [
        { rowNumber: 2, values: { personalNumber: "0000004", name: "עודכן" } },
      ],
    });
    const batch = await command(
      "import.apply",
      {
        id: preview.id,
        confirmed: true,
        overwriteConfirmed: true,
        reason: "עדכון",
      },
      preview.version
    );
    expect(batch.invitationsStatus).toBe("not_needed");
    await expect(publish(batch)).rejects.toMatchObject({
      code: "invitations_not_unpublished",
    });
    expect(await invitations()).toHaveLength(1);
  });

  it("publishes only surviving rows after a partial restore", async () => {
    const batch = await intake([
      {
        rowNumber: 3,
        values: {
          personalNumber: "0000003",
          name: "ללא פעילות",
          email: "quiet@example.invalid",
        },
      },
    ]);
    await db
      .update(user)
      .set({ firstSignInAt: new Date() })
      .where(eq(user.email, "imported@example.invalid"));
    const preview = await command(
      "import.restore.preview",
      { id: batch.id },
      batch.version
    );
    const restored = await command(
      "import.restore",
      {
        id: batch.id,
        token: preview.token,
        confirmed: true,
        reason: "ביטול קליטה ללא פעילות",
      },
      batch.version
    );
    expect(restored.status).toBe("partially_restored");
    expect(await publish(restored)).toMatchObject({
      invitationsQueued: 1,
      invitationsSkipped: 1,
    });
    expect(await invitations()).toHaveLength(1);
    expect(
      await db
        .select()
        .from(user)
        .where(eq(user.email, "quiet@example.invalid"))
    ).toHaveLength(0);
  });

  it("removes pending published invitations when the intake is restored", async () => {
    const batch = await publish(await intake());
    expect(await invitations()).toHaveLength(1);
    const preview = await command(
      "import.restore.preview",
      { id: batch.id },
      batch.version
    );
    await command(
      "import.restore",
      {
        id: batch.id,
        token: preview.token,
        confirmed: true,
        reason: "ביטול לפני משלוח",
      },
      batch.version
    );
    expect(await invitations()).toHaveLength(0);
  });
});
