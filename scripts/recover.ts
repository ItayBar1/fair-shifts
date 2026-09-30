import { pool } from "../src/server/db";
import { recoverTechnicalAccess } from "../src/server/auth/accounts";
try {
  const codes = await recoverTechnicalAccess(
    process.env.RECOVERY_EMAIL ?? "",
    process.env.RECOVERY_REASON ?? ""
  );
  console.log(
    "Access released; a new sign-in is required. New recovery codes, keep them outside the repository:"
  );
  console.log(codes.join("\n"));
} finally {
  await pool.end();
}
