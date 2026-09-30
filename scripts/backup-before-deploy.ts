// Runs in the worker container of the version still live, before a deployment
// that changes the database (card #36): requests a backup and waits until it
// is verified. scripts/auto-deploy.sh deploys only after exit code 0. English
// output: it is read in the deployment journal on the server (decision 187).
import { pool } from "../src/server/db";
import {
  backupBeforeDeploy,
  type DeployBackupResult,
} from "../src/server/operations/backup";

function outcome(result: DeployBackupResult) {
  switch (result.status) {
    case "verified":
      return `backup ${result.runId.slice(0, 8)} verified: ${result.fileName}`;
    case "failed":
      return `backup ${result.runId.slice(0, 8)} failed (${result.code}); see the backup screen`;
    case "stalled":
      return `backup ${result.runId.slice(0, 8)} was not taken up by the worker; is it running?`;
    case "disabled":
      return "backups are not enabled in the running worker";
    case "restore":
      return "restore mode is on; no backup is taken";
  }
}

try {
  const result = await backupBeforeDeploy(process.argv[2] ?? "unknown");
  if (result.status === "verified") console.log(outcome(result));
  else console.error(outcome(result));
  process.exitCode = result.status === "verified" ? 0 : 1;
} finally {
  await pool.end();
}
