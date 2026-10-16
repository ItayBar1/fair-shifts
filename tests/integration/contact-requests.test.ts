import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, pool } from "../../src/server/db";
import { contactRequests, emailOutbox, records } from "../../src/server/schema";
import { createInvitedAccount } from "../../src/server/auth/accounts";
import {
  CONTACT_LIMITS,
  KEEP_DAYS,
  refreshContactDigest,
  submitContactRequest,
} from "../../src/server/contact-requests";
import { errorResponse } from "../../src/server/http";

let technicalId: string;
beforeEach(async () => {
  await db.execute(
    sql`truncate table auth_user, auth_budget, auth_rate_limit, soldiers, duty_types, unit_lock, email_quota, operations_state, command_results, contact_requests cascade`
  );
  technicalId = (
    await createInvitedAccount({
      name: "טכני פניות",
      role: "technical",
      email: "contact-technical@example.invalid",
    })
  ).id;
});
afterAll(async () => {
  await pool.end();
});

const form = (body: Record<string, unknown>) =>
  new Request("http://localhost/api/contact", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const valid = {
  name: "נועה לוי",
  contact: "noa@example.invalid",
  message: "אני רוצה לעיין במידע שנשמר עליי",
};
// 05:30 UTC is 08:30 in Israel on these dates (IDT, UTC+3).
const morning = (day: number, minutes = 0) =>
  new Date(Date.UTC(2026, 9, day, 5, 30 + minutes));
const technicalMail = () =>
  db
    .select()
    .from(emailOutbox)
    .where(eq(emailOutbox.recipientAccountId, technicalId));
const notices = async () =>
  (
    await db.select().from(records).where(eq(records.kind, "notification"))
  ).filter((row) => row.data.accountId === technicalId);
const digest = (now: Date) =>
  db.transaction((tx) => refreshContactDigest(tx, now));

describe("the public contact form (decision 228)", () => {
  it("stores a request without mailing anyone, and drops a bot's quietly", async () => {
    await submitContactRequest(form(valid), morning(10));
    await submitContactRequest(
      form({ ...valid, website: "https://spam.example" }),
      morning(10)
    );
    const stored = await db.select().from(contactRequests);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ ...valid, digestedAt: null });
    expect(await technicalMail()).toHaveLength(0);
  });

  it("rejects an incomplete request and limits each sender per day", async () => {
    const missing = await submitContactRequest(
      form({ name: "", contact: "x", message: "" }),
      morning(10)
    ).catch((error: unknown) => errorResponse(error));
    expect(missing?.status).toBe(422);
    for (let i = 0; i < CONTACT_LIMITS.sender; i++)
      await submitContactRequest(form(valid), morning(10));
    const over = await submitContactRequest(form(valid), morning(10)).catch(
      (error: unknown) => errorResponse(error)
    );
    expect(over?.status).toBe(429);
    expect(await db.select().from(contactRequests)).toHaveLength(
      CONTACT_LIMITS.sender
    );
    // A new quota day opens the sender again.
    await submitContactRequest(form(valid), morning(11));
    expect(await db.select().from(contactRequests)).toHaveLength(
      CONTACT_LIMITS.sender + 1
    );
  });

  it("mails the technical account one digest a day, only when there are new requests", async () => {
    // Nothing to send: no mail, and the day stays open for a later request.
    expect(await digest(morning(10))).toBe(0);
    await submitContactRequest(form(valid), morning(10, 5));
    await submitContactRequest(
      form({ ...valid, name: "דן כהן", contact: "0501234567" }),
      morning(10, 6)
    );
    // Before 08:00 Israel time the digest waits.
    expect(await digest(new Date(Date.UTC(2026, 9, 10, 4, 0)))).toBe(0);
    expect(await digest(morning(10, 10))).toBe(2);
    const [mail] = await technicalMail();
    expect(mail).toMatchObject({ kind: "contact-digest" });
    expect(mail!.title).toBe("2 פניות חדשות מטופס יצירת הקשר");
    expect(mail!.body).toContain("נועה לוי");
    expect(mail!.body).toContain("פרטי קשר: 0501234567");
    expect(mail!.body).toContain(valid.message);
    const [notice] = await notices();
    expect(notice!.data).toMatchObject({ body: "הפרטים נשלחו במייל." });
    expect(JSON.stringify(notice!.data)).not.toContain(valid.message);

    // A request later the same day waits for tomorrow's digest.
    await submitContactRequest(
      form({ ...valid, name: "רון" }),
      morning(10, 60)
    );
    expect(await digest(morning(10, 120))).toBe(0);
    expect(await technicalMail()).toHaveLength(1);
    expect(await digest(morning(11))).toBe(1);
    expect(await digest(morning(11, 30))).toBe(0);
    expect(await digest(morning(12))).toBe(0);
    expect(await technicalMail()).toHaveLength(2);
    expect(await notices()).toHaveLength(2);
  });

  it("deletes a request 30 days after its digest", async () => {
    await submitContactRequest(form(valid), morning(1));
    await digest(morning(1, 10));
    await digest(
      new Date(morning(1, 10).getTime() + (KEEP_DAYS - 1) * 86_400_000)
    );
    expect(await db.select().from(contactRequests)).toHaveLength(1);
    await digest(new Date(morning(1, 20).getTime() + KEEP_DAYS * 86_400_000));
    expect(await db.select().from(contactRequests)).toHaveLength(0);
  });
});
