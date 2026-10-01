import { db, pool } from "../src/server/db";
import {
  deletionLogConfig,
  verifyDeletionLog,
  type LogVerification,
} from "../src/server/operations/deletion-log";
import {
  ACKNOWLEDGEMENT,
  acknowledgeUnverifiedLog,
  applyLoggedDeletions,
} from "../src/server/restore-deletions";

// Output is English: it is read on the server (decision 187). Nothing sensitive
// is printed: counts, states and reason codes only.
const usage = `Usage: pnpm deletion-log <command>

  verify       check the log against its storage copy and this database (read only)
  apply        verify, then apply the deletions the database does not show yet;
               the restore gate stays closed for this check unless it succeeds
  acknowledge  open the gate although the log is missing or unverified.
               Needs DELETION_LOG_REASON and DELETION_LOG_ACKNOWLEDGE="${ACKNOWLEDGEMENT}"`;

function report(result: LogVerification) {
  console.log(`Deletion log: ${result.status.toUpperCase()}`);
  console.log(
    `Local copy: ${result.local.status} (${result.local.length} entries)`
  );
  console.log(
    `Storage copy: ${result.remote.status} (${result.remote.length} entries)`
  );
  if (result.source)
    console.log(
      `Log in use: ${result.source}, ${result.entries.length} entries`
    );
  if (result.reasons.length)
    console.log(`Reasons: ${result.reasons.join(", ")}`);
  if (result.warnings.length)
    console.log(`Warnings: ${result.warnings.join(", ")}`);
  if (result.unloggedDeletions.length)
    console.log(
      `Soldiers marked deleted in this database but absent from the log: ${result.unloggedDeletions.length}`
    );
}

const [command] = process.argv.slice(2);
let code = 0;
try {
  const config = deletionLogConfig();
  if (!["verify", "apply", "acknowledge"].includes(command ?? "")) {
    console.error(usage);
    code = 2;
  } else if (!config.directory) {
    console.error("DELETION_LOG_DIRECTORY is not set");
    code = 2;
  } else if (command === "verify") {
    const result = await verifyDeletionLog(db, config);
    report(result);
    code = result.status === "verified" ? 0 : 1;
  } else if (command === "apply") {
    const result = await applyLoggedDeletions(config);
    report(result.verification);
    if (result.status === "blocked") {
      console.log(
        "Access and mail stay closed. Fix the log, or clarify and run: pnpm deletion-log acknowledge"
      );
      code = 1;
    } else
      console.log(
        `Applied ${result.applied}, already deleted ${result.alreadyDeleted}, not in this database ${result.notInDatabase}. The deletion check of the restore gate is clear (log head ${result.head}).`
      );
  } else {
    const result = await acknowledgeUnverifiedLog(
      {
        reason: process.env.DELETION_LOG_REASON ?? "",
        acknowledgement: process.env.DELETION_LOG_ACKNOWLEDGE ?? "",
      },
      config
    );
    report(result);
    console.log(
      "The deletion check of the restore gate is clear by acknowledgement. The managers were notified that deleted data may have returned."
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Failed");
  code = 1;
} finally {
  await pool.end();
}
process.exit(code);
