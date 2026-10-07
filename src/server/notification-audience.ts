import { and, eq, inArray, isNull } from "drizzle-orm";
import type { DbTransaction } from "./db";
import { user } from "./auth-schema";
import { soldiers } from "./schema";
import { canAccessAfterService } from "../domain/eligibility";

type StaffRole = "manager" | "technical";

/** Product callers hold the unit lock; restore callers operate behind its gate. */
export async function staffNotificationRecipients(
  tx: DbTransaction,
  roles: readonly StaffRole[] = ["manager"],
  now = new Date()
) {
  const rows = await tx
    .select({ account: user, soldier: soldiers })
    .from(user)
    .leftJoin(soldiers, eq(soldiers.id, user.soldierId))
    .where(and(inArray(user.role, [...roles]), isNull(user.deletedAt)))
    .orderBy(user.id);
  return rows
    .filter(({ account, soldier }) =>
      account.role === "technical"
        ? account.soldierId === null
        : Boolean(
            soldier &&
            !soldier.deletedAt &&
            canAccessAfterService(soldier.data, now.toISOString())
          )
    )
    .map(({ account }) => account);
}

/** Current permission and service, rather than the role at queue creation. */
export async function staffMailRelevant(
  tx: DbTransaction,
  account: typeof user.$inferSelect,
  kind: string,
  now: Date
) {
  const roles: readonly StaffRole[] | undefined =
    kind === "departure" || kind === "deletion"
      ? ["manager"]
      : kind === "restore"
        ? ["manager", "technical"]
        : undefined;
  if (!roles) return true;
  if (!roles.includes(account.role as StaffRole) || account.deletedAt)
    return false;
  if (account.role === "technical") return account.soldierId === null;
  const [person] = await tx
    .select()
    .from(soldiers)
    .where(eq(soldiers.id, account.soldierId!));
  return Boolean(
    person &&
    !person.deletedAt &&
    canAccessAfterService(person.data, now.toISOString())
  );
}
