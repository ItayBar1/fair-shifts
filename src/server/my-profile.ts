import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { DbTransaction } from "./db";
import { invariant } from "./errors";
import { audit, createRecord, type Actor } from "./repository";
import { soldierContacts, soldiers } from "./schema";
import { phone } from "./validation";
import { staffNotificationRecipients } from "./notification-audience";

const contactInput = z.object({
  phone,
  // An empty address clears it; the address is optional (decision 222).
  address: z
    .string()
    .trim()
    .max(500)
    .transform((value) => value || null),
  versions: z.object({
    phone: z.number().int().nonnegative(),
    address: z.number().int().nonnegative(),
  }),
});
const labels = { phone: "טלפון", address: "כתובת" } as const;

/**
 * A soldier changes their own phone and address (decision 222). The change is
 * saved at once, logged like a manager's edit, and every manager gets a site
 * notice naming the fields; the values stay in the profile, not in the notice.
 */
export async function updateOwnContact(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown
) {
  // A manager's own details are kept from the soldiers list, like anyone's.
  invariant(
    actor.role === "soldier" && actor.soldierId,
    "FORBIDDEN",
    "חייל מעדכן כאן את פרטי הקשר שלו בלבד",
    403
  );
  const soldierId = actor.soldierId;
  const input = contactInput.parse(payload);
  const [person] = await tx
    .select()
    .from(soldiers)
    .where(eq(soldiers.id, soldierId));
  invariant(person && !person.deletedAt, "not_found", "הפרופיל לא נמצא", 404);
  const [contact] = await tx
    .select()
    .from(soldierContacts)
    .where(eq(soldierContacts.soldierId, soldierId))
    .for("update");
  const versions = contact?.fieldVersions ?? {};
  invariant(
    (versions.phone ?? 0) === input.versions.phone &&
      (versions.address ?? 0) === input.versions.address,
    "stale_version",
    "הפרטים השתנו בינתיים. יש לטעון את המסך מחדש",
    409
  );
  const changes = (["phone", "address"] as const).flatMap((field) => {
    const before = contact?.[field] ?? null;
    const after = input[field];
    return before === after ? [] : [{ field, before, after }];
  });
  if (!changes.length) return { changed: false };
  if (contact)
    await tx
      .update(soldierContacts)
      .set({ phone: input.phone, address: input.address })
      .where(eq(soldierContacts.soldierId, soldierId));
  else
    await tx.insert(soldierContacts).values({
      soldierId,
      phone: input.phone,
      address: input.address,
    });
  // Contact details are personal; the list lives in an erasable detail record.
  await audit(
    tx,
    actor,
    "soldier.update",
    soldierId,
    { fields: changes.map((change) => change.field), self: true },
    soldierId,
    { changes }
  );
  const fields = changes.map((change) => labels[change.field]).join(" ו");
  const eventId = randomUUID();
  for (const account of await staffNotificationRecipients(tx))
    await createRecord(tx, "notification", {
      accountId: account.id,
      title: "עדכון פרטי קשר",
      body: `${person.name} עדכן/ה בעצמו/ה ${fields}.`,
      href: "/manage/soldiers",
      requestId: eventId,
    });
  return { changed: true };
}
