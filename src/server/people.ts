import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { profileInput } from "./validation";
import { audit, currentVersion, manager, type Actor } from "./repository";
import { soldiers, soldierContacts, balances } from "./schema";
import { user } from "./auth-schema";
import type { DbTransaction } from "./db";
import { invariant } from "./errors";
import { createInvitedAccount } from "./auth/accounts";
import { enqueueEmail } from "./operations/email";
import type { Soldier } from "../domain/types";
import { postScore } from "./scoring";
import { effectiveToday, reassessAssignments } from "./personnel";
import { populationAt } from "../domain/eligibility";
import { refreshRankReminders } from "./ranks";

export async function saveSoldier(
  tx: DbTransaction,
  actor: Actor,
  payload: unknown,
  expectedVersion?: number
) {
  manager(actor);
  const input = profileInput.parse(payload);
  const [existing] = input.id
    ? await tx.select().from(soldiers).where(eq(soldiers.id, input.id))
    : [];
  const [contact] = input.id
    ? await tx
        .select()
        .from(soldierContacts)
        .where(eq(soldierContacts.soldierId, input.id))
    : [];
  if (input.id) {
    invariant(
      existing && !existing.deletedAt,
      "not_found",
      "חייל לא נמצא",
      404
    );
    currentVersion(existing.version, expectedVersion);
    invariant(
      !input.email || input.email.toLowerCase() === contact?.email,
      "email_verification_required",
      "שינוי מייל מחייב אימות הכתובת החדשה"
    );
    const [balance] = await tx
      .select()
      .from(balances)
      .where(eq(balances.soldierId, input.id));
    invariant(
      input.currentScore === undefined ||
        input.currentScore === balance.current,
      "score_preview_required",
      "שינוי יתרה נעשה דרך מסך הניקוד עם תצוגה מקדימה"
    );
  } else invariant(input.email, "email_required", "נדרשת כתובת מייל להזמנה");
  const id = existing?.id ?? randomUUID();
  const data: Soldier = {
    ...existing?.data,
    id,
    name: input.name,
    personalNumber: input.personalNumber,
    version: (existing?.version ?? 0) + 1,
    currentScore: existing?.data.currentScore ?? 0,
    populationHistory: existing?.data.populationHistory ?? [],
    rankHistory: existing?.data.rankHistory ?? [],
    qualifications: existing?.data.qualifications ?? [],
    exemptions: existing?.data.exemptions ?? [],
    inactivePeriods: existing?.data.inactivePeriods ?? [],
    constraints: [],
    service: {
      type: input.serviceType,
      basePopulation: existing?.data.service.basePopulation ?? input.population,
      arrivalDate: input.arrivalDate,
      enlistmentDate: input.enlistmentDate,
      graceEligible: input.graceEligible,
      permanentFrom: input.permanentDate,
      officerFrom: input.officerDate,
      releaseDate: input.releaseDate,
    },
  };
  if (
    existing &&
    populationAt(existing.data, new Date().toISOString()) !== input.population
  ) {
    data.populationHistory = [
      ...data.populationHistory.filter(
        (row) => row.effectiveFrom !== effectiveToday()
      ),
      { effectiveFrom: effectiveToday(), population: input.population },
    ];
  }
  if (existing) {
    await tx
      .update(soldiers)
      .set({
        name: data.name,
        personalNumber: data.personalNumber,
        data,
        version: data.version,
        updatedAt: new Date(),
      })
      .where(eq(soldiers.id, id));
    if (input.phone !== undefined || input.address !== undefined) {
      const fieldVersions = { ...contact?.fieldVersions };
      for (const field of ["phone", "address"] as const)
        if (input[field] !== undefined)
          fieldVersions[field] = (fieldVersions[field] ?? 0) + 1;
      await tx
        .update(soldierContacts)
        .set({ phone: input.phone, address: input.address, fieldVersions })
        .where(eq(soldierContacts.soldierId, id));
    }
    await tx
      .update(user)
      .set({ name: data.name, population: input.population })
      .where(eq(user.soldierId, id));
  } else {
    await tx.insert(soldiers).values({
      id,
      name: data.name,
      personalNumber: data.personalNumber,
      data,
    });
    await tx.insert(soldierContacts).values({
      soldierId: id,
      email: input.email!.toLowerCase(),
      phone: input.phone,
      address: input.address,
    });
    await tx.insert(balances).values({ soldierId: id });
    if (input.currentScore)
      await postScore(tx, {
        soldierId: id,
        sourceKey: `opening:${id}`,
        kind: "opening",
        actorId: actor.id,
        reason: "יתרת פתיחה בקליטה ידנית",
        effectiveAt: new Date(),
        amount: input.currentScore,
      });
    const account = await createInvitedAccount(
      {
        name: data.name,
        email: input.email!,
        soldierId: id,
        population: input.population,
      },
      tx
    );
    await enqueueEmail(tx, {
      recipientAccountId: account.id,
      eventKey: `invitation:${account.id}`,
      kind: "invitation",
      title: "הוזמנת לתורנות הוגנת",
      body: `ניתן להתחבר בכתובת ${process.env.BETTER_AUTH_URL}/login באמצעות כתובת המייל הזאת.`,
      priority: 1,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
  }
  await audit(tx, actor, existing ? "soldier.update" : "soldier.create", id);
  if (existing) await reassessAssignments(tx, id);
  await refreshRankReminders(tx);
  return { id, version: data.version };
}
