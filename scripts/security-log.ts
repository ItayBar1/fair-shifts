import { db, pool } from "../src/server/db";
import {
  deletionLogConfig,
  verifyDeletionLog,
  readState,
} from "../src/server/operations/deletion-log";
import { convertDeletionLog } from "../src/server/operations/log-conversion";
import { requireConversionBackup } from "../src/server/operations/security-backup";
try {
  const config = deletionLogConfig();
  if (process.argv[2] === "convert") {
    await requireConversionBackup();
    console.log(
      `Signed ${await convertDeletionLog(config)} legacy deletion log entries`
    );
  } else if (process.argv[2] === "verify") {
    const result = await verifyDeletionLog(db, config, { strict: true });
    if (result.status !== "verified") {
      const state = await readState(db);
      const deleted = await db.execute(
        "select 1 from soldiers where deleted_at is not null and not exists (select 1 from records where kind = 'deletion_log_entry' and subject_id = soldiers.id and data->>'status' = 'pending') limit 1"
      );
      if (!(
        result.reasons.length === 1 &&
        result.reasons[0] === "no_log" &&
        !(state.headSeq ?? 0) &&
        !deleted.rows.length
      ))
        throw new Error("Deletion log verification failed");
    }
    console.log(
      "Deletion log signatures and history are valid, or this is a fresh empty log"
    );
  } else throw new Error("Usage: pnpm security:log <verify|convert>");
} catch {
  console.error(
    "Deletion log verification or conversion failed; preserve both copies and the verified backup for recovery"
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
