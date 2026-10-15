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
import { fullName, gender, phone } from "../src/server/validation";

try {
  const input = z
    .object({
      TECHNICAL_EMAIL: z.email(),
      TECHNICAL_NAME: z.string().min(1),
      MANAGER_EMAIL: z.email(),
      // The first manager has the details every intake requires (decision 222).
      MANAGER_FIRST_NAME: z.string().trim().min(1).max(100),
      MANAGER_LAST_NAME: z.string().trim().min(1).max(100),
      MANAGER_GENDER: gender,
      MANAGER_PHONE: phone,
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
      name: fullName(input.MANAGER_FIRST_NAME, input.MANAGER_LAST_NAME),
      firstName: input.MANAGER_FIRST_NAME,
      lastName: input.MANAGER_LAST_NAME,
      gender: input.MANAGER_GENDER,
      version: 1,
      currentScore: 0,
      service: {
        type: "mandatory",
        basePopulation: "mandatory",
        graceEligible: false,
      },
      populationHistory: [],
      rankHistory: [],
      exemptions: [],
      inactivePeriods: [],
      constraints: [],
    };
    await tx.insert(soldiers).values({ id, name: data.name, data });
    await tx.insert(soldierContacts).values({
      soldierId: id,
      email: input.MANAGER_EMAIL.toLowerCase(),
      phone: input.MANAGER_PHONE,
    });
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
