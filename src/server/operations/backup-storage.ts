import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { BackupFailureCode } from "../../domain/backup";

/**
 * Where encrypted backups are kept. The Drive adapter is the production target;
 * the directory adapter serves tests and local runs. Both manage only files the
 * application created, found by the run id stamped on each file.
 */
export type StoredFile = { id: string; size: number; sha256: string };
export type BackupStorage = {
  kind: "drive" | "directory";
  /** Free bytes, or undefined when the target reports no limit. */
  freeBytes(): Promise<number | undefined>;
  upload(input: {
    path: string;
    name: string;
    runId: string;
    size: number;
    /** Marks a file that is not a backup, such as the deletion log (decision 196). */
    kind?: string;
  }): Promise<StoredFile>;
  /** Files an earlier attempt of the same run may have left behind. */
  findRun(runId: string): Promise<StoredFile[]>;
  /** Every file of a kind the application uploaded, found without the database. */
  findKind(kind: string): Promise<StoredFile[]>;
  get(id: string): Promise<StoredFile | undefined>;
  /** The content of a file the application uploaded; undefined when it is gone. */
  read(id: string): Promise<Buffer | undefined>;
  /** Permanent removal; a file that is already gone is not an error. */
  remove(id: string): Promise<void>;
};

/** A failure with a safe category; provider text never reaches logs or screens. */
export class BackupFailure extends Error {
  constructor(public code: BackupFailureCode) {
    super(code);
  }
}

export async function fileDigest(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

// ---------------------------------------------------------------- directory

const RUN_PREFIX = "fair-shifts-";
/** File names carry the run id: fair-shifts-<runId>--<name>. */
export function directoryStorage(
  root: string,
  quotaBytes?: number
): BackupStorage {
  const ours = async () => {
    await mkdir(root, { recursive: true });
    return (await readdir(root)).filter((name) => name.startsWith(RUN_PREFIX));
  };
  const describe = async (name: string): Promise<StoredFile> => {
    const path = join(root, name);
    return {
      id: name,
      size: (await stat(path)).size,
      sha256: await fileDigest(path),
    };
  };
  return {
    kind: "directory",
    async freeBytes() {
      if (quotaBytes === undefined) return undefined;
      // Every file counts, as in a shared Drive quota.
      await mkdir(root, { recursive: true });
      let used = 0;
      for (const name of await readdir(root))
        used += (await stat(join(root, name))).size;
      return Math.max(0, quotaBytes - used);
    },
    async upload({ path, name, runId, kind }) {
      const target = `${RUN_PREFIX}${kind ? `${kind}-` : ""}${runId}--${name}`;
      await mkdir(root, { recursive: true });
      await copyFile(path, join(root, target));
      return describe(target);
    },
    async findRun(runId) {
      return Promise.all(
        (await ours())
          .filter((name) => name.startsWith(`${RUN_PREFIX}${runId}--`))
          .map(describe)
      );
    },
    async findKind(kind) {
      return Promise.all(
        (await ours())
          .filter((name) => name.startsWith(`${RUN_PREFIX}${kind}-`))
          .map(describe)
      );
    },
    async get(id) {
      if (!id.startsWith(RUN_PREFIX) || id.includes("/")) return undefined;
      return (await ours()).includes(id) ? describe(id) : undefined;
    },
    async read(id) {
      if (!id.startsWith(RUN_PREFIX) || id.includes("/")) return undefined;
      return (await ours()).includes(id) ? readFile(join(root, id)) : undefined;
    },
    async remove(id) {
      if (!id.startsWith(RUN_PREFIX) || id.includes("/")) return;
      await rm(join(root, id), { force: true });
    },
  };
}

// ---------------------------------------------------------------- Google Drive

const DRIVE = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const FOLDER_MARK = "fairShiftsFolder";
const RUN_MARK = "fairShiftsRun";
const KIND_MARK = "fairShiftsKind";
const FILE_FIELDS = "id,size,sha256Checksum";
const REQUEST_TIMEOUT_MS = 60_000;
const UPLOAD_TIMEOUT_MS = 30 * 60_000;

export type DriveCredentials = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** Optional: an application-created folder; otherwise one is created. */
  folderId?: string;
};
type DriveFile = { id: string; size?: string; sha256Checksum?: string };

/**
 * Uses the drive.file scope: the account's other files are invisible to the
 * application, so retention cannot touch them. Deletion is permanent rather
 * than to the trash, whose contents count against the shared 15GB.
 */
export function driveStorage(
  credentials: DriveCredentials,
  fetcher: typeof fetch = fetch
): BackupStorage {
  let token: { value: string; until: number } | undefined;
  let folder = credentials.folderId;

  async function accessToken() {
    if (token && token.until > Date.now()) return token.value;
    const response = await safeFetch(
      fetcher,
      "https://oauth2.googleapis.com/token",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: credentials.clientId,
          client_secret: credentials.clientSecret,
          refresh_token: credentials.refreshToken,
        }),
      }
    );
    if (response.status === 400 || response.status === 401)
      throw new BackupFailure("auth_expired");
    if (!response.ok) throw new BackupFailure("upload_failed");
    const body = (await response.json()) as {
      access_token: string;
      expires_in?: number;
    };
    token = {
      value: body.access_token,
      until: Date.now() + Math.max(0, (body.expires_in ?? 3600) - 120) * 1000,
    };
    return token.value;
  }

  async function call(
    url: string,
    init: RequestInit = {},
    failure: BackupFailureCode = "upload_failed",
    timeoutMs = REQUEST_TIMEOUT_MS
  ) {
    const response = await safeFetch(
      fetcher,
      url,
      {
        ...init,
        headers: {
          ...(init.headers as Record<string, string>),
          authorization: `Bearer ${await accessToken()}`,
        },
      },
      timeoutMs
    );
    if (response.status === 401) throw new BackupFailure("auth_expired");
    if (response.status === 403 && (await quotaExceeded(response)))
      throw new BackupFailure("insufficient_space");
    if (!response.ok && response.status !== 404)
      throw new BackupFailure(failure);
    return response;
  }

  async function list(query: string) {
    const params = new URLSearchParams({
      q: `${query} and trashed = false`,
      fields: `files(${FILE_FIELDS})`,
      spaces: "drive",
    });
    const response = await call(`${DRIVE}/files?${params}`);
    if (response.status === 404) return [];
    return ((await response.json()) as { files: DriveFile[] }).files;
  }

  async function folderId() {
    if (folder) return folder;
    const [existing] = await list(
      `mimeType = 'application/vnd.google-apps.folder' and appProperties has { key='${FOLDER_MARK}' and value='backups' }`
    );
    if (existing) return (folder = existing.id);
    const response = await call(`${DRIVE}/files?fields=id`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Fair Shifts backups",
        mimeType: "application/vnd.google-apps.folder",
        appProperties: { [FOLDER_MARK]: "backups" },
      }),
    });
    return (folder = ((await response.json()) as DriveFile).id);
  }

  const stored = (file: DriveFile): StoredFile => ({
    id: file.id,
    size: Number(file.size ?? -1),
    sha256: file.sha256Checksum ?? "",
  });

  return {
    kind: "drive",
    async freeBytes() {
      const response = await call(`${DRIVE}/about?fields=storageQuota`);
      const { storageQuota } = (await response.json()) as {
        storageQuota: { limit?: string; usage?: string };
      };
      if (!storageQuota.limit) return undefined;
      return Math.max(
        0,
        Number(storageQuota.limit) - Number(storageQuota.usage ?? 0)
      );
    },
    async upload({ path, name, runId, size, kind }) {
      const parent = await folderId();
      const session = await call(
        `${UPLOAD}?uploadType=resumable&fields=${FILE_FIELDS}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json; charset=UTF-8",
            "x-upload-content-type": "application/octet-stream",
            "x-upload-content-length": String(size),
          },
          body: JSON.stringify({
            name,
            parents: [parent],
            appProperties: {
              [RUN_MARK]: runId,
              ...(kind && { [KIND_MARK]: kind }),
            },
          }),
        }
      );
      const location = session.headers.get("location");
      if (!session.ok || !location) throw new BackupFailure("upload_failed");
      const response = await call(
        location,
        {
          method: "PUT",
          headers: {
            "content-type": "application/octet-stream",
            "content-length": String(size),
          },
          body: Readable.toWeb(createReadStream(path)) as ReadableStream,
          duplex: "half",
        } as RequestInit,
        "upload_failed",
        UPLOAD_TIMEOUT_MS
      );
      if (!response.ok) throw new BackupFailure("upload_failed");
      return stored((await response.json()) as DriveFile);
    },
    async findRun(runId) {
      return (
        await list(
          `appProperties has { key='${RUN_MARK}' and value='${runId}' }`
        )
      ).map(stored);
    },
    async findKind(kind) {
      return (
        await list(
          `appProperties has { key='${KIND_MARK}' and value='${kind}' }`
        )
      ).map(stored);
    },
    async read(id) {
      const response = await call(
        `${DRIVE}/files/${encodeURIComponent(id)}?alt=media`
      );
      if (response.status === 404) return undefined;
      return Buffer.from(await response.arrayBuffer());
    },
    async get(id) {
      const response = await call(
        `${DRIVE}/files/${encodeURIComponent(id)}?fields=${FILE_FIELDS},trashed`
      );
      if (response.status === 404) return undefined;
      const file = (await response.json()) as DriveFile & { trashed?: boolean };
      return file.trashed ? undefined : stored(file);
    },
    async remove(id) {
      await call(`${DRIVE}/files/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
    },
  };
}

async function safeFetch(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs = REQUEST_TIMEOUT_MS
): Promise<Response> {
  try {
    return await fetcher(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // Network errors can echo URLs with tokens; keep only the category.
    throw new BackupFailure("upload_failed");
  }
}

async function quotaExceeded(response: Response) {
  try {
    const body = (await response.clone().json()) as {
      error?: { errors?: { reason?: string }[] };
    };
    return Boolean(
      body.error?.errors?.some((item) => item.reason === "storageQuotaExceeded")
    );
  } catch {
    return false;
  }
}
