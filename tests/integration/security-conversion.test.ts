import {
  createCipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, pool } from "../../src/server/db";
import { emailOutbox, backupRun } from "../../src/server/auth-schema";
import { requireConversionBackup } from "../../src/server/operations/security-backup";
import { calendarLink, soldiers, balances } from "../../src/server/schema";
import { createInvitedAccount } from "../../src/server/auth/accounts";
import { openSecret, sealSecret, secretKey } from "../../src/server/secrets";
import {
  convertStoredSecrets,
  verifyStoredSecrets,
} from "../../src/server/operations/secret-conversion";
import { convertDeletionLog } from "../../src/server/operations/log-conversion";
import { directoryStorage } from "../../src/server/operations/backup-storage";
import {
  DELETION_LOG_FILE,
  DELETION_LOG_KIND,
  mergeState,
  verifyDeletionLog,
} from "../../src/server/operations/deletion-log";
import { GENESIS_HASH } from "../../src/domain/deletion-log";
import { entryHash, serializeEntry } from "../../src/domain/deletion-log";
import { applyLoggedDeletions } from "../../src/server/restore-deletions";
import { testLogKeys } from "../log-keys";
import { soldier } from "../fixtures";
if (
  !process.env.TEST_DATABASE_URL ||
  process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL ||
  !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test")
)
  throw new Error("Requires a dedicated test database");
const roots: string[] = [];
beforeEach(async () => {
  await db.execute(
    sql`truncate table auth_user, auth_budget, auth_rate_limit, soldiers, duty_types, unit_lock, email_quota, operations_state, command_results, backup_run cascade`
  );
});
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
afterAll(async () => pool.end());
async function person() {
  const id = randomUUID();
  await db.insert(soldiers).values({
    id,
    name: "סינתטי",
    personalNumber: randomUUID(),
    data: soldier({ id }),
  });
  await db.insert(balances).values({ soldierId: id });
  return createInvitedAccount({
    name: "סינתטי",
    role: "soldier",
    email: `${id}@example.invalid`,
    soldierId: id,
  });
}
function legacySecret(text: string) {
  const nonce = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", secretKey(), nonce);
  const encrypted = Buffer.concat([cipher.update(text), cipher.final()]);
  return [nonce, cipher.getAuthTag(), encrypted]
    .map((part) => part.toString("base64url"))
    .join(".");
}
async function oldLog() {
  const root = await mkdtemp(join(tmpdir(), "security-log-conversion-"));
  roots.push(root);
  const directory = join(root, "local"),
    store = join(root, "remote");
  await mkdir(directory);
  await mkdir(store);
  const config = {
    directory,
    storage: directoryStorage(store),
    ...testLogKeys,
  };
  const body = {
    v: 1,
    seq: 1,
    id: randomUUID(),
    soldierId: randomUUID(),
    at: new Date().toISOString(),
    prev: GENESIS_HASH,
  };
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        body.v,
        body.seq,
        body.id,
        body.soldierId,
        body.at,
        body.prev,
      ])
    )
    .digest("hex");
  const content = JSON.stringify({ ...body, hash }) + "\n",
    path = join(directory, DELETION_LOG_FILE);
  await writeFile(path, content);
  const remote = await config.storage.upload({
    path,
    name: DELETION_LOG_FILE,
    runId: randomUUID(),
    size: Buffer.byteLength(content),
    kind: DELETION_LOG_KIND,
  });
  await mergeState(db, { headSeq: 1, headHash: hash });
  return { config, content, path, remote };
}
describe("controlled stored-secret conversion", () => {
  it("requires stopped-service acknowledgement and a recent verified backup whose stored hash still matches", async () => {
    const root = await mkdtemp(join(tmpdir(), "security-backup-preflight-"));
    roots.push(root);
    const path = join(root, "synthetic.age");
    await writeFile(path, randomBytes(128));
    const storage = directoryStorage(root),
      id = randomUUID();
    const stored = await storage.upload({
      path,
      name: "synthetic.age",
      runId: id,
      size: 128,
    });
    await db.insert(backupRun).values({
      id,
      key: randomUUID(),
      trigger: "manual",
      status: "verified",
      finishedAt: new Date(),
      storageId: stored.id,
      sizeBytes: stored.size,
      sha256: stored.sha256,
    });
    const env = {
      SECURITY_BACKUP_RUN_ID: id,
      SECURITY_CONVERSION_ACKNOWLEDGEMENT:
        "services stopped and backup verified",
      BACKUP_STORAGE: "directory",
      BACKUP_DIRECTORY: root,
    };
    await requireConversionBackup(env);
    await expect(
      requireConversionBackup({
        ...env,
        SECURITY_CONVERSION_ACKNOWLEDGEMENT: undefined,
      })
    ).rejects.toThrow("acknowledge");
    await expect(
      requireConversionBackup(env, new Date(Date.now() + 86400_001))
    ).rejects.toThrow("24 hours");
    await writeFile(join(root, stored.id), "changed");
    await expect(requireConversionBackup(env)).rejects.toThrow(
      "missing or changed"
    );
  });
  it("converts existing mail and Calendar atomically, binds contexts and permits an idempotent second pass", async () => {
    const account = await person(),
      id = randomUUID();
    await db.insert(emailOutbox).values({
      id,
      recipientAccountId: account.id,
      eventKey: randomUUID(),
      kind: "login-code",
      title: "סינתטי",
      body: "סינתטי",
      encryptedSecret: legacySecret("123456"),
      expiresAt: new Date(Date.now() + 60000),
    });
    await db.insert(calendarLink).values({
      accountId: account.id,
      refreshToken: legacySecret("synthetic-refresh"),
      state: "active",
    });
    await expect(verifyStoredSecrets()).rejects.toThrow();
    expect(await convertStoredSecrets()).toBe(2);
    await verifyStoredSecrets();
    expect(await convertStoredSecrets()).toBe(0);
    const [mail] = await db.select().from(emailOutbox),
      [link] = await db.select().from(calendarLink);
    expect(
      openSecret(mail.encryptedSecret!, { purpose: "mail-code", recordId: id })
    ).toBe("123456");
    expect(
      openSecret(link.refreshToken!, {
        purpose: "calendar-refresh",
        recordId: account.id,
      })
    ).toBe("synthetic-refresh");
    expect(() =>
      openSecret(mail.encryptedSecret!, {
        purpose: "mail-code",
        recordId: randomUUID(),
      })
    ).toThrow();
  });
  it("rolls back every conversion if one old secret is corrupt, and refuses copied v2 secrets", async () => {
    const account = await person(),
      id = randomUUID();
    const old = legacySecret("123456");
    await db.insert(emailOutbox).values({
      id,
      recipientAccountId: account.id,
      eventKey: randomUUID(),
      kind: "login-code",
      title: "סינתטי",
      body: "סינתטי",
      encryptedSecret: old,
      expiresAt: new Date(Date.now() + 60000),
    });
    await db.insert(calendarLink).values({
      accountId: account.id,
      refreshToken: "invalid",
      state: "active",
    });
    await expect(convertStoredSecrets()).rejects.toThrow();
    expect((await db.select().from(emailOutbox))[0].encryptedSecret).toBe(old);
    await db
      .update(calendarLink)
      .set({
        refreshToken: sealSecret("copied", {
          purpose: "calendar-refresh",
          recordId: "another-account",
        }),
      })
      .where(eq(calendarLink.accountId, account.id));
    await expect(convertStoredSecrets()).rejects.toThrow();
  });
});
describe("controlled unsigned-log conversion", () => {
  it("blocks restore when both copies contain a deletion with recomputed hashes but no valid signature", async () => {
    const { config, path } = await oldLog();
    await convertDeletionLog(config);
    const forged = JSON.parse((await readFile(path, "utf8")).trim());
    forged.soldierId = randomUUID();
    forged.hash = entryHash(forged);
    const content = serializeEntry(forged);
    await writeFile(path, content);
    for (const file of await config.storage.findKind(DELETION_LOG_KIND))
      await config.storage.remove(file.id);
    await config.storage.upload({
      path,
      name: DELETION_LOG_FILE,
      runId: randomUUID(),
      size: Buffer.byteLength(content),
      kind: DELETION_LOG_KIND,
    });
    expect(
      await applyLoggedDeletions({ ...config, signer: undefined })
    ).toMatchObject({
      status: "blocked",
      verification: {
        status: "unverified",
        reasons: ["local_broken", "remote_broken"],
      },
    });
  });
  it("refuses unsigned logs during restore and signs only matching local, remote and database histories", async () => {
    const { config } = await oldLog();
    expect((await verifyDeletionLog(db, config)).status).toBe("unverified");
    expect(await convertDeletionLog(config)).toBe(1);
    expect(
      await verifyDeletionLog(db, { ...config, signer: undefined })
    ).toMatchObject({
      status: "verified",
      entries: [{ v: 2, keyId: "synthetic-test" }],
    });
  });
  it("refuses unequal old copies without changing the local copy", async () => {
    const { config, path, content } = await oldLog();
    await writeFile(path, content.replace('"seq":1', '"seq":2'));
    await expect(convertDeletionLog(config)).rejects.toThrow("copies differ");
    expect(await readFile(path, "utf8")).toContain('"seq":2');
  });
  it("refuses a database head mismatch and does not sign the old file", async () => {
    const { config, path, content } = await oldLog();
    await mergeState(db, { headHash: "f".repeat(64) });
    await expect(convertDeletionLog(config)).rejects.toThrow("database head");
    expect(await readFile(path, "utf8")).toBe(content);
  });
});
