import { pool } from "../src/server/db";
import { recoverTechnicalAccess } from "../src/server/auth/accounts";
try {
  const codes = await recoverTechnicalAccess(
    process.env.RECOVERY_EMAIL ?? "",
    process.env.RECOVERY_REASON ?? ""
  );
  console.log(
    "הגישה שוחררה ונדרשת התחברות מחדש. קודי שחזור חדשים לשמירה מחוץ למאגר:"
  );
  console.log(codes.join("\n"));
} finally {
  await pool.end();
}
