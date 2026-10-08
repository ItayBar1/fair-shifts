// The legacy reader belongs only to the explicit operations conversion tool.
// Site, worker and Calendar never import this module.
import { createDecipheriv } from "node:crypto";
import { eq, isNotNull, sql } from "drizzle-orm";
import { db, type Database } from "../db";
import { emailOutbox } from "../auth-schema";
import { calendarLink } from "../schema";
import {
  openSecret,
  sealSecret,
  secretKey,
  type SecretContext,
} from "../secrets";

function openLegacy(value: string) {
  const parts = value.split(".");
  if (
    parts.length !== 3 ||
    parts.some((part) => !/^[A-Za-z0-9_-]*$/.test(part))
  )
    throw new Error("Legacy secret format is invalid");
  const [nonce, tag, encrypted] = parts.map((part) =>
    Buffer.from(part, "base64url")
  );
  if (
    nonce.length !== 12 ||
    tag.length !== 16 ||
    parts.some(
      (part, i) => part !== [nonce, tag, encrypted][i].toString("base64url")
    )
  )
    throw new Error("Legacy secret format is invalid");
  const decipher = createDecipheriv("aes-256-gcm", secretKey(), nonce, {
    authTagLength: 16,
  });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString(
    "utf8"
  );
}
const convert = (value: string, context: SecretContext) => {
  if (value.startsWith("v2.")) {
    openSecret(value, context);
    return value;
  }
  return sealSecret(openLegacy(value), context);
};
export async function convertStoredSecrets(database: Database = db) {
  return database.transaction(async (tx) => {
    await tx.execute(
      sql`lock table email_outbox, calendar_link in share row exclusive mode`
    );
    let converted = 0;
    for (const row of await tx
      .select()
      .from(emailOutbox)
      .where(isNotNull(emailOutbox.encryptedSecret))) {
      const next = convert(row.encryptedSecret!, {
        purpose: "mail-code",
        recordId: row.id,
      });
      if (next !== row.encryptedSecret) {
        await tx
          .update(emailOutbox)
          .set({ encryptedSecret: next })
          .where(eq(emailOutbox.id, row.id));
        converted++;
      }
    }
    for (const row of await tx
      .select()
      .from(calendarLink)
      .where(isNotNull(calendarLink.refreshToken))) {
      const next = convert(row.refreshToken!, {
        purpose: "calendar-refresh",
        recordId: row.accountId,
      });
      if (next !== row.refreshToken) {
        await tx
          .update(calendarLink)
          .set({ refreshToken: next })
          .where(eq(calendarLink.accountId, row.accountId));
        converted++;
      }
    }
    return converted;
  });
}
export async function verifyStoredSecrets(database: Database = db) {
  for (const row of await database
    .select()
    .from(emailOutbox)
    .where(isNotNull(emailOutbox.encryptedSecret)))
    openSecret(row.encryptedSecret!, {
      purpose: "mail-code",
      recordId: row.id,
    });
  for (const row of await database
    .select()
    .from(calendarLink)
    .where(isNotNull(calendarLink.refreshToken)))
    openSecret(row.refreshToken!, {
      purpose: "calendar-refresh",
      recordId: row.accountId,
    });
}
