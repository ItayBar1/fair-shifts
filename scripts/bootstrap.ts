import { randomUUID } from "node:crypto";
import { z } from "zod";
import { pool, unitTransaction } from "../src/server/db";
import { user } from "../src/server/auth-schema";
import { soldiers, soldierContacts, balances } from "../src/server/schema";
import {
  createInvitedAccount,
  issueRecoveryCodes,
} from "../src/server/auth/accounts";
import { invariant } from "../src/server/errors";
import type { Soldier } from "../src/domain/types";

try {
  const input = z
    .object({
      TECHNICAL_EMAIL: z.email(),
      TECHNICAL_NAME: z.string().min(1),
      MANAGER_EMAIL: z.email(),
      MANAGER_NAME: z.string().min(1),
      MANAGER_PERSONAL_NUMBER: z.string().regex(/^\d{1,20}$/),
    })
    .parse(process.env);
  const recovery = await unitTransaction(async (tx) => {
    invariant(
      (await tx.select({ id: user.id }).from(user).limit(1)).length === 0,
      "already_initialized",
      "The system is already set up; grant access through the technical screens"
    );
    const technical = await createInvitedAccount(
      {
        name: input.TECHNICAL_NAME,
        email: input.TECHNICAL_EMAIL,
        role: "technical",
      },
      tx
    );
    const id = randomUUID();
    const data: Soldier = {
      id,
      name: input.MANAGER_NAME,
      personalNumber: input.MANAGER_PERSONAL_NUMBER,
      version: 1,
      currentScore: 0,
      service: {
        type: "mandatory",
        basePopulation: "mandatory",
        graceEligible: false,
      },
      populationHistory: [],
      rankHistory: [],
      qualifications: [],
      exemptions: [],
      inactivePeriods: [],
      constraints: [],
    };
    await tx.insert(soldiers).values({
      id,
      name: data.name,
      personalNumber: data.personalNumber,
      data,
    });
    await tx
      .insert(soldierContacts)
      .values({ soldierId: id, email: input.MANAGER_EMAIL.toLowerCase() });
    await tx.insert(balances).values({ soldierId: id });
    await createInvitedAccount(
      {
        name: data.name,
        email: input.MANAGER_EMAIL,
        role: "manager",
        soldierId: id,
      },
      tx
    );
    return issueRecoveryCodes(technical.id, tx);
  });
  console.log(
    "System set up. The recovery codes below are shown once. Keep them outside the repository and shared logs."
  );
  console.log(recovery.join("\n"));
} finally {
  await pool.end();
}
