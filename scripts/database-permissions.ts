import { pool } from "../src/server/db";
import {
  applyDatabaseGrants,
  checkDatabaseRole,
  databaseRoles,
  type ServiceRole,
} from "../src/server/operations/database-permissions";
try {
  const role = process.env.SERVICE_ROLE as ServiceRole;
  if (!Object.hasOwn(databaseRoles, role))
    throw new Error("SERVICE_ROLE is required");
  if (process.argv[2] === "apply") {
    if (role !== "operations")
      throw new Error("Only operations may apply database grants");
    const errors = await checkDatabaseRole(role);
    if (errors.length) throw new Error(errors.join("; "));
    await applyDatabaseGrants();
  } else if (process.argv[2] !== "check")
    throw new Error("Usage: pnpm db:permissions <check|apply>");
  const errors = await checkDatabaseRole(role);
  if (errors.length) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
  } else console.log(`Database permissions are valid (${role})`);
} catch {
  console.error("Database permission verification failed");
  process.exitCode = 1;
} finally {
  await pool.end();
}
