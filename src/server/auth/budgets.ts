import { and, eq, sql } from "drizzle-orm";
import type { DbTransaction } from "../db";
import { authBudget } from "../auth-schema";
import { quotaDay } from "../operations/mail-quota-day";

/** Reservations survive cancellation and restarts. A pair is all-or-nothing. */
export async function reserveDailyBudget(
  tx: DbTransaction,
  category: string,
  accountId: string,
  amount: number,
  accountLimit: number,
  unitLimit: number | undefined,
  now = new Date()
): Promise<boolean> {
  if (!Number.isSafeInteger(amount) || amount < 1)
    throw new Error("Budget amount must be a positive integer");
  const day = quotaDay(now);
  const where = (scope: string) =>
    and(
      eq(authBudget.day, day),
      eq(authBudget.category, category),
      eq(authBudget.scope, scope)
    );
  // Every caller takes the shared row first, including callers for different accounts.
  await tx
    .insert(authBudget)
    .values({ day, category, scope: "unit", used: 0 })
    .onConflictDoNothing();
  const [unit] = await tx
    .select()
    .from(authBudget)
    .where(where("unit"))
    .for("update");
  const scope = `account:${accountId}`;
  await tx
    .insert(authBudget)
    .values({ day, category, scope, used: 0 })
    .onConflictDoNothing();
  const [account] = await tx
    .select()
    .from(authBudget)
    .where(where(scope))
    .for("update");
  if (
    account.used + amount > accountLimit ||
    (unitLimit !== undefined && unit.used + amount > unitLimit)
  )
    return false;
  await tx
    .update(authBudget)
    .set({ used: sql`${authBudget.used} + ${amount}` })
    .where(where("unit"));
  await tx
    .update(authBudget)
    .set({ used: sql`${authBudget.used} + ${amount}` })
    .where(where(scope));
  return true;
}

const codeLimits = {
  "login-code": { account: 10, unit: 200 },
  "email-change": { account: 10, unit: 30 },
} as const;
export function reserveCodeBudget(
  tx: DbTransaction,
  kind: keyof typeof codeLimits,
  accountId: string,
  amount: number,
  phase: "issue" | "attempt",
  now = new Date()
) {
  const limit = codeLimits[kind];
  return reserveDailyBudget(
    tx,
    `${kind}:${phase}`,
    accountId,
    amount,
    limit.account,
    limit.unit,
    now
  );
}
