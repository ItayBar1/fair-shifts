import { createHmac, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, lt } from "drizzle-orm";
import { DateTime } from "luxon";
import { z } from "zod";
import { db, type DbTransaction } from "./db";
import { contactRequests, operationsState, user } from "./schema";
import { AppError } from "./errors";
import { createRecord } from "./repository";
import { enqueueEmail } from "./operations/email";
import { reserveDailyBudget } from "./auth/budgets";
import { clientBucket } from "./auth/rate-limit";
import { secret } from "./auth/policy";
import {
  AUTH_BODY_LIMIT,
  parseBoundedJson,
  readBoundedBody,
} from "./bounded-body";
import { UNIT_ZONE } from "../domain/time";

/** Per sender address and for the whole site, per quota day (decision 228). */
export const CONTACT_LIMITS = { sender: 3, site: 30 } as const;
/** The digest goes out once a day, from this hour Israel time. */
export const DIGEST_HOUR = 8;
/** A request is deleted this many days after the digest that carried it. */
export const KEEP_DAYS = 30;
const DIGEST_STATE = "contact-digest";

export const contactInput = z
  .object({
    name: z.string().trim().min(1, "יש למלא שם").max(100),
    contact: z.string().trim().min(3, "יש למלא מייל או טלפון לחזרה").max(200),
    message: z.string().trim().min(1, "יש לכתוב את הפנייה").max(2000),
    // A field people do not see. A bot that fills it gets a quiet success.
    website: z.string().max(200).optional(),
  })
  .strict();

/**
 * Stores a request from the public form. No mail is sent here: the worker
 * sends the technical account one digest a day.
 */
export async function submitContactRequest(request: Request, now = new Date()) {
  const input = contactInput.parse(
    parseBoundedJson(await readBoundedBody(request, AUTH_BODY_LIMIT))
  );
  if (input.website) return;
  const sender = createHmac("sha256", secret("OTP_SECRET"))
    .update(`contact-ip:${clientBucket(request)}`)
    .digest("hex");
  await db.transaction(async (tx) => {
    const allowed = await reserveDailyBudget(
      tx,
      "contact",
      sender,
      1,
      CONTACT_LIMITS.sender,
      CONTACT_LIMITS.site,
      now
    );
    if (!allowed)
      throw new AppError(
        "rate_limit",
        "נשלחו היום יותר מדי פניות. אפשר לנסות שוב מחר, או לפנות לאחראי התורנויות ביחידה",
        429
      );
    await tx.insert(contactRequests).values({
      id: randomUUID(),
      name: input.name,
      contact: input.contact,
      message: input.message,
      createdAt: now,
    });
  });
}

export function digestText(
  requests: {
    name: string;
    contact: string;
    message: string;
    createdAt: Date;
  }[]
) {
  const title =
    requests.length === 1
      ? "פנייה חדשה מטופס יצירת הקשר"
      : `${requests.length} פניות חדשות מטופס יצירת הקשר`;
  const items = requests.map((request, index) =>
    [
      `${index + 1}. ${request.name}`,
      `פרטי קשר: ${request.contact}`,
      `נשלחה: ${DateTime.fromJSDate(request.createdAt).setZone(UNIT_ZONE).toFormat("dd.LL.yyyy HH:mm")}`,
      request.message,
    ].join("\n")
  );
  return {
    title,
    body: `${items.join("\n\n")}\n\nהפניות נשלחו מטופס יצירת הקשר בדף מדיניות הפרטיות. הן נמחקות מהאתר ${KEEP_DAYS} יום אחרי המייל הזה.`,
  };
}

/**
 * Once a quota day, from DIGEST_HOUR, mails each technical account the
 * requests not yet sent, if there are any, and deletes old ones. Returns how
 * many requests the digest carried.
 */
export async function refreshContactDigest(
  tx: DbTransaction,
  now = new Date()
) {
  await tx
    .delete(contactRequests)
    .where(
      lt(
        contactRequests.digestedAt,
        new Date(now.getTime() - KEEP_DAYS * 86_400_000)
      )
    );
  const local = DateTime.fromJSDate(now).setZone(UNIT_ZONE);
  if (local.hour < DIGEST_HOUR) return 0;
  const day = local.toFormat("yyyy-LL-dd");
  const [state] = await tx
    .select()
    .from(operationsState)
    .where(eq(operationsState.key, DIGEST_STATE))
    .for("update");
  if (state?.data.day === day) return 0;
  const pending = await tx
    .select()
    .from(contactRequests)
    .where(isNull(contactRequests.digestedAt))
    .orderBy(asc(contactRequests.createdAt));
  if (!pending.length) return 0;
  const text = digestText(pending);
  const accounts = await tx
    .select({ id: user.id })
    .from(user)
    .where(and(eq(user.role, "technical"), isNull(user.deletedAt)));
  for (const account of accounts) {
    // The site notice carries no request details; the mail does.
    await createRecord(tx, "notification", {
      accountId: account.id,
      title: text.title,
      body: "הפרטים נשלחו במייל.",
      href: "/technical",
    });
    await enqueueEmail(tx, {
      recipientAccountId: account.id,
      eventKey: `contact:${day}:${account.id}`,
      kind: "contact-digest",
      ...text,
      expiresAt: new Date(now.getTime() + 2 * 86_400_000),
    });
  }
  await tx
    .update(contactRequests)
    .set({ digestedAt: now })
    .where(
      inArray(
        contactRequests.id,
        pending.map((request) => request.id)
      )
    );
  const data = { day };
  await tx
    .insert(operationsState)
    .values({ key: DIGEST_STATE, data, updatedAt: now })
    .onConflictDoUpdate({
      target: operationsState.key,
      set: { data, updatedAt: now },
    });
  return pending.length;
}
