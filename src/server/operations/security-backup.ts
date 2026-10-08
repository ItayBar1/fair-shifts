import { eq } from "drizzle-orm";
import { db } from "../db";
import { backupRun } from "../auth-schema";
import { backupConfig } from "./backup";

/** A DB status alone is insufficient: verify the stored encrypted file again. */
export async function requireConversionBackup(
  env: Record<string, string | undefined> = process.env,
  now = new Date()
) {
  if (
    env.SECURITY_CONVERSION_ACKNOWLEDGEMENT !==
    "services stopped and backup verified"
  )
    throw new Error(
      "Stop site and worker and acknowledge the conversion prerequisites"
    );
  const id = env.SECURITY_BACKUP_RUN_ID;
  if (!id || !/^[0-9a-f-]{36}$/i.test(id))
    throw new Error("SECURITY_BACKUP_RUN_ID is required");
  const [row] = await db.select().from(backupRun).where(eq(backupRun.id, id));
  if (
    !row ||
    row.status !== "verified" ||
    !row.finishedAt ||
    now.getTime() - row.finishedAt.getTime() > 86400_000 ||
    row.finishedAt > now ||
    !row.storageId ||
    !row.sha256 ||
    !row.sizeBytes
  )
    throw new Error("A verified backup from the last 24 hours is required");
  const stored = await backupConfig(env).storage?.get(row.storageId);
  if (!stored || stored.sha256 !== row.sha256 || stored.size !== row.sizeBytes)
    throw new Error("The verified backup is missing or changed in storage");
}
