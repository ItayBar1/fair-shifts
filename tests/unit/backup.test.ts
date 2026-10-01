import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  beyondRetention,
  dailyBackupDue,
  isTransient,
  retryDelay,
  spaceToFree,
  MAX_BACKUPS,
} from "../../src/domain/backup";
import { validateDeploymentConfig } from "../../src/server/config";
import {
  BackupFailure,
  directoryStorage,
  driveStorage,
} from "../../src/server/operations/backup-storage";
import { backupFreshness, formatBytes } from "../../src/client/backups";
import {
  preferencesPayload,
  hiddenPreferenceTypes,
} from "../../src/client/notifications";

const MB = 1024 * 1024;
const copy = (day: number, sizeBytes = 10 * MB) => ({
  id: `copy-${day}`,
  finishedAt: new Date(Date.UTC(2026, 8, day, 1)),
  sizeBytes,
});

describe("daily backup schedule in Israel time", () => {
  it("is due from 03:30 Israel time until the end of that Israel date", () => {
    // 29.09.2026 is summer time (UTC+3): 03:30 local is 00:30 UTC.
    expect(dailyBackupDue(new Date("2026-09-29T00:29:00Z"))).toBeNull();
    expect(dailyBackupDue(new Date("2026-09-29T00:30:00Z"))).toBe(
      "daily:2026-09-29"
    );
    expect(dailyBackupDue(new Date("2026-09-29T20:59:00Z"))).toBe(
      "daily:2026-09-29"
    );
    // 21:00 UTC is already the next Israel date, before its 03:30.
    expect(dailyBackupDue(new Date("2026-09-29T21:00:00Z"))).toBeNull();
    // Winter time (UTC+2) and a configured time.
    expect(dailyBackupDue(new Date("2026-12-01T01:29:00Z"))).toBeNull();
    expect(dailyBackupDue(new Date("2026-12-01T01:30:00Z"))).toBe(
      "daily:2026-12-01"
    );
    expect(dailyBackupDue(new Date("2026-12-01T20:00:00Z"), "22:15")).toBe(
      null
    );
    expect(dailyBackupDue(new Date("2026-12-01T20:15:00Z"), "22:15")).toBe(
      "daily:2026-12-01"
    );
  });
  it("keeps one key on the nights the clock changes", () => {
    // Spring forward (27.03.2026) and fall back (25.10.2026) happen before 03:30.
    expect(dailyBackupDue(new Date("2026-03-27T00:30:00Z"))).toBe(
      "daily:2026-03-27"
    );
    expect(dailyBackupDue(new Date("2026-10-25T01:29:00Z"))).toBeNull();
    expect(dailyBackupDue(new Date("2026-10-25T01:30:00Z"))).toBe(
      "daily:2026-10-25"
    );
  });
});

describe("retries", () => {
  it("retries transient failures after 15 minutes and an hour only", () => {
    expect(isTransient("upload_failed")).toBe(true);
    expect(isTransient("dump_failed")).toBe(true);
    for (const code of [
      "key_missing",
      "auth_expired",
      "insufficient_space",
      "not_configured",
    ] as const)
      expect(isTransient(code)).toBe(false);
    expect(retryDelay(1)).toBe(15 * 60_000);
    expect(retryDelay(2)).toBe(60 * 60_000);
  });
});

describe("retention by count and by free space", () => {
  it("keeps the newest 30 verified copies", () => {
    const copies = Array.from({ length: MAX_BACKUPS + 2 }, (_, i) =>
      copy(i + 1)
    );
    expect(beyondRetention(copies).map((row) => row.id)).toEqual([
      "copy-2",
      "copy-1",
    ]);
    expect(beyondRetention(copies.slice(0, 30))).toEqual([]);
  });
  it("frees the oldest copies first and never the newest verified one", () => {
    const copies = [copy(3), copy(1), copy(2)];
    expect(spaceToFree(copies, 5 * MB, 20 * MB)).toEqual({
      remove: [],
      fits: true,
    });
    expect(spaceToFree(copies, 15 * MB, 10 * MB)).toEqual({
      remove: [copy(1)],
      fits: true,
    });
    expect(spaceToFree(copies, 25 * MB, 10 * MB)).toEqual({
      remove: [copy(1), copy(2)],
      fits: true,
    });
    // Even removing both older copies is not enough; copy-3 stays.
    expect(spaceToFree(copies, 40 * MB, 10 * MB)).toEqual({
      remove: [copy(1), copy(2)],
      fits: false,
    });
    expect(spaceToFree([], 1, 0).fits).toBe(false);
    expect(spaceToFree([copy(1)], 5 * MB, undefined)).toEqual({
      remove: [],
      fits: true,
    });
  });
});

describe("backup configuration check", () => {
  const valid = {
    DEPLOYMENT_ENVIRONMENT: "staging",
    APP_VERSION: "abc123def456",
    DATABASE_URL:
      "postgresql://fair_shifts:5f1c0d9e8b7a6c5d4e3f2a1b@db:5432/fair_shifts",
    BETTER_AUTH_URL: "https://staging.example.invalid",
    BETTER_AUTH_SECRET: "a".repeat(20) + "b".repeat(20),
    OTP_SECRET: "c".repeat(20) + "d".repeat(20),
    MAIL_ENCRYPTION_KEY: "9f".repeat(32),
    MAIL_TRANSPORT: "disabled",
  };
  const recipient = `age1${"q".repeat(58)}`;
  it("accepts backups off, and Drive with a public age key", () => {
    expect(validateDeploymentConfig(valid)).toEqual([]);
    expect(
      validateDeploymentConfig({
        ...valid,
        BACKUP_STORAGE: "drive",
        GOOGLE_DRIVE_CLIENT_ID: "synthetic-client",
        GOOGLE_DRIVE_CLIENT_SECRET: "synthetic-secret",
        GOOGLE_DRIVE_REFRESH_TOKEN: "synthetic-refresh",
        AGE_RECIPIENT: recipient,
        BACKUP_TIME: "04:05",
      })
    ).toEqual([]);
  });
  it("names missing Drive settings and rejects a private key", () => {
    const privateKey = `AGE-SECRET-KEY-1${"Q".repeat(58)}`;
    const errors = validateDeploymentConfig({
      ...valid,
      BACKUP_STORAGE: "drive",
      AGE_RECIPIENT: privateKey,
      BACKUP_TIME: "25:00",
    });
    for (const name of [
      "GOOGLE_DRIVE_CLIENT_ID",
      "GOOGLE_DRIVE_CLIENT_SECRET",
      "GOOGLE_DRIVE_REFRESH_TOKEN",
      "AGE_RECIPIENT",
      "BACKUP_TIME",
    ])
      expect(errors.some((error) => error.startsWith(`${name}:`))).toBe(true);
    expect(errors.join("\n")).not.toContain(privateKey);
    expect(
      validateDeploymentConfig({ ...valid, BACKUP_STORAGE: "s3" })
    ).toHaveLength(1);
  });
});

type Call = { url: string; init: RequestInit };
function fakeDrive(
  respond: (call: Call) => Response | undefined,
  calls: Call[] = [],
  token = () =>
    Response.json({ access_token: "synthetic-access", expires_in: 3600 })
) {
  const fetcher = (async (url: string | URL, init: RequestInit = {}) => {
    const call = { url: String(url), init };
    calls.push(call);
    if (call.url.startsWith("https://oauth2.googleapis.com/token"))
      return token();
    return respond(call) ?? new Response("{}", { status: 500 });
  }) as typeof fetch;
  return driveStorage(
    {
      clientId: "synthetic-client",
      clientSecret: "synthetic-secret",
      refreshToken: "synthetic-refresh",
      folderId: "folder-1",
    },
    fetcher
  );
}
const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error) => (error instanceof BackupFailure ? error.code : "other")
  );

describe("Google Drive adapter", () => {
  it("reads free space from the account quota, including unlimited", async () => {
    const calls: Call[] = [];
    const storage = fakeDrive(
      () =>
        Response.json({
          storageQuota: { limit: String(15 * 1024 * MB), usage: String(MB) },
        }),
      calls
    );
    expect(await storage.freeBytes()).toBe(15 * 1024 * MB - MB);
    const about = calls.find((call) => call.url.includes("/about"))!;
    expect((about.init.headers as Record<string, string>).authorization).toBe(
      "Bearer synthetic-access"
    );
    const unlimited = fakeDrive(() => Response.json({ storageQuota: {} }));
    expect(await unlimited.freeBytes()).toBeUndefined();
  });
  it("reports a revoked or expired grant as auth_expired", async () => {
    const revoked = fakeDrive(
      () => undefined,
      [],
      () => Response.json({ error: "invalid_grant" }, { status: 400 })
    );
    expect(await failure(revoked.freeBytes())).toBe("auth_expired");
    const unauthorized = fakeDrive(() => new Response("", { status: 401 }));
    expect(await failure(unauthorized.freeBytes())).toBe("auth_expired");
  });
  it("maps a full account to insufficient_space and other errors to upload_failed", async () => {
    const full = fakeDrive(() =>
      Response.json(
        { error: { errors: [{ reason: "storageQuotaExceeded" }] } },
        { status: 403 }
      )
    );
    expect(await failure(full.findRun("run-1"))).toBe("insufficient_space");
    const limited = fakeDrive(() =>
      Response.json(
        { error: { errors: [{ reason: "rateLimitExceeded" }] } },
        { status: 403 }
      )
    );
    expect(await failure(limited.findRun("run-1"))).toBe("upload_failed");
    const offline = driveStorage(
      {
        clientId: "c",
        clientSecret: "s",
        refreshToken: "r",
      },
      (async () => {
        throw new Error("connect ECONNREFUSED https://secret.invalid/?token=x");
      }) as typeof fetch
    );
    expect(await failure(offline.freeBytes())).toBe("upload_failed");
  });
  it("finds only the application's files of a run, excluding the trash", async () => {
    const calls: Call[] = [];
    const storage = fakeDrive(
      () =>
        Response.json({
          files: [{ id: "f1", size: "12", sha256Checksum: "ab" }],
        }),
      calls
    );
    expect(await storage.findRun("run-1")).toEqual([
      { id: "f1", size: 12, sha256: "ab" },
    ]);
    const query = new URL(calls.at(-1)!.url).searchParams.get("q")!;
    expect(query).toContain(
      "appProperties has { key='fairShiftsRun' and value='run-1' }"
    );
    expect(query).toContain("trashed = false");
  });
  it("lists the encrypted dumps newest first without the database, leaving the deletion log and foreign files out (ticket #35)", async () => {
    const calls: Call[] = [];
    const storage = fakeDrive(
      () =>
        Response.json({
          files: [
            {
              id: "new",
              name: "fair-shifts-20261001-033000-aaaaaaaa.dump.age",
              size: "20",
              sha256Checksum: "n",
              createdTime: "2026-10-01T00:30:05.000Z",
              appProperties: { fairShiftsRun: "run-2" },
            },
            {
              id: "log",
              name: "deletion-log.jsonl",
              size: "3",
              sha256Checksum: "l",
              createdTime: "2026-10-01T00:31:00.000Z",
              appProperties: {
                fairShiftsRun: "log-1",
                fairShiftsKind: "deletion-log",
              },
            },
            {
              id: "old",
              name: "fair-shifts-20260930-033000-bbbbbbbb.dump.age",
              size: "10",
              sha256Checksum: "o",
              createdTime: "2026-09-30T00:30:05.000Z",
              appProperties: { fairShiftsRun: "run-1" },
            },
            {
              id: "other",
              name: "notes.txt",
              size: "1",
              createdTime: "2026-09-01T00:00:00.000Z",
            },
          ],
        }),
      calls
    );
    expect(await storage.listBackups()).toEqual([
      {
        id: "new",
        size: 20,
        sha256: "n",
        name: "fair-shifts-20261001-033000-aaaaaaaa.dump.age",
        createdAt: new Date("2026-10-01T00:30:05.000Z"),
      },
      {
        id: "old",
        size: 10,
        sha256: "o",
        name: "fair-shifts-20260930-033000-bbbbbbbb.dump.age",
        createdAt: new Date("2026-09-30T00:30:05.000Z"),
      },
    ]);
    const url = new URL(calls.at(-1)!.url);
    const query = url.searchParams.get("q")!;
    expect(query).toContain("'folder-1' in parents");
    expect(query).toContain("trashed = false");
    expect(url.searchParams.get("orderBy")).toBe("createdTime desc");
  });
  it("tags the deletion log as its own kind and finds it again without the database (decision 196)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fs-drive-kind-"));
    scratch.push(dir);
    const file = join(dir, "deletion-log.jsonl");
    await writeFile(file, "x\n");
    const calls: Call[] = [];
    const storage = fakeDrive((call) => {
      if (call.url.includes("uploadType=resumable"))
        return new Response(null, {
          status: 200,
          headers: { location: "https://upload.example.invalid/session" },
        });
      if (call.init.method === "PUT")
        return Response.json({ id: "f9", size: "2", sha256Checksum: "cc" });
      return Response.json({
        files: [{ id: "f9", size: "2", sha256Checksum: "cc" }],
      });
    }, calls);
    await storage.upload({
      path: file,
      name: "deletion-log.jsonl",
      runId: "deletion-log-1",
      size: 2,
      kind: "deletion-log",
    });
    const start = calls.find((call) =>
      call.url.includes("uploadType=resumable")
    )!;
    expect(JSON.parse(String(start.init.body)).appProperties).toEqual({
      fairShiftsRun: "deletion-log-1",
      fairShiftsKind: "deletion-log",
    });
    // A backup upload carries no kind, so it is never mistaken for the log.
    await storage.upload({
      path: file,
      name: "b.age",
      runId: "run-9",
      size: 2,
    });
    const plain = calls
      .filter((call) => call.url.includes("uploadType=resumable"))
      .at(-1)!;
    expect(JSON.parse(String(plain.init.body)).appProperties).toEqual({
      fairShiftsRun: "run-9",
    });
    expect(await storage.findKind("deletion-log")).toEqual([
      { id: "f9", size: 2, sha256: "cc" },
    ]);
    const query = new URL(calls.at(-1)!.url).searchParams.get("q")!;
    expect(query).toContain(
      "appProperties has { key='fairShiftsKind' and value='deletion-log' }"
    );
    expect(query).toContain("trashed = false");
  });
  it("reads a file's content and treats a missing file as gone", async () => {
    const calls: Call[] = [];
    const storage = fakeDrive(
      () => new Response("line one\n", { status: 200 }),
      calls
    );
    expect((await storage.read("f 1"))!.toString()).toBe("line one\n");
    expect(calls.at(-1)!.url).toContain("/files/f%201?alt=media");
    const gone = fakeDrive(() => new Response(null, { status: 404 }));
    expect(await gone.read("f1")).toBeUndefined();
    expect(
      await failure(
        fakeDrive(() => new Response("", { status: 500 })).read("f1")
      )
    ).toBe("upload_failed");
  });
  it("deletes permanently and treats a missing file as gone", async () => {
    const calls: Call[] = [];
    const storage = fakeDrive(() => new Response(null, { status: 404 }), calls);
    await storage.remove("f1");
    expect(calls.at(-1)!.init.method).toBe("DELETE");
    expect(calls.at(-1)!.url).toContain("/files/f1");
    expect(await storage.get("f1")).toBeUndefined();
  });
});

const scratch: string[] = [];
afterAll(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
});

describe("directory storage and the deletion log kind", () => {
  it("lists the log apart from the backups, reads it, and refuses a path outside the folder", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fs-dir-kind-"));
    scratch.push(dir);
    const source = join(dir, "source.bin");
    await writeFile(source, "content");
    const storage = directoryStorage(join(dir, "store"));
    const backup = await storage.upload({
      path: source,
      name: "dump.age",
      runId: "run-1",
      size: 7,
    });
    const log = await storage.upload({
      path: source,
      name: "deletion-log.jsonl",
      runId: "deletion-log-1-abc",
      size: 7,
      kind: "deletion-log",
    });
    expect(
      (await storage.findKind("deletion-log")).map((file) => file.id)
    ).toEqual([log.id]);
    expect((await storage.findRun("run-1")).map((file) => file.id)).toEqual([
      backup.id,
    ]);
    expect((await storage.read(log.id))!.toString()).toBe("content");
    expect(await storage.read("../source.bin")).toBeUndefined();
    expect(await storage.read("fair-shifts-gone")).toBeUndefined();
  });
});

describe("backup screen helpers", () => {
  const now = Date.UTC(2026, 8, 29, 12);
  it("flags a missing or day-and-a-half-old verified backup", () => {
    expect(backupFreshness({ kind: "none" }, now)).toBe("disabled");
    expect(backupFreshness({ kind: "drive" }, now)).toBe("missing");
    expect(
      backupFreshness(
        {
          kind: "drive",
          lastVerifiedAt: new Date(now - 30 * 3600_000).toISOString(),
        },
        now
      )
    ).toBe("ok");
    expect(
      backupFreshness(
        {
          kind: "drive",
          lastVerifiedAt: new Date(now - 37 * 3600_000).toISOString(),
        },
        now
      )
    ).toBe("stale");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(undefined)).toBe("—");
  });
  it("shows the restore notice switch to managers and the technical account, never to a soldier (decision 200)", () => {
    expect(hiddenPreferenceTypes("manager")).not.toContain("restore");
    expect(hiddenPreferenceTypes("technical")).not.toContain("restore");
    expect(hiddenPreferenceTypes("soldier")).toContain("restore");
    expect(hiddenPreferenceTypes(undefined)).toContain("restore");
  });
  it("shows the operations email switch to the technical account only", () => {
    expect(hiddenPreferenceTypes("technical")).toEqual([
      "departure",
      "deletion",
    ]);
    expect(hiddenPreferenceTypes("manager")).toEqual(["operations"]);
    expect(hiddenPreferenceTypes("soldier")).toEqual([
      "departure",
      "operations",
      "deletion",
      "restore",
    ]);
    // A soldier's form keeps the hidden switch as it was.
    const payload = preferencesPayload(
      { reminderHours: "24", "email.transfer": true },
      hiddenPreferenceTypes("soldier"),
      { operations: false }
    );
    expect(payload.email).toMatchObject({ transfer: true, operations: false });
  });
});
