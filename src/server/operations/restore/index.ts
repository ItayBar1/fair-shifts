/**
 * Restoring from a backup (decision 200, ticket #35).
 *
 * A backup is never restored over the live database. It is decrypted into a
 * database of its own, brought up to this version's schema, closed behind the
 * restore gate, given the deletions made since it was taken (decision 196), and
 * checked. Only a database that passed can replace the live one, by renaming
 * the two; the old one is kept under another name. A drill is the same run on a
 * scratch database that is dropped afterwards, so it can be done on the live
 * server without touching it.
 *
 * Output is English: it is read on the server (decision 187). Nothing printed or
 * stored here carries a name, a personal number or contact details.
 */
// One module per stage (decision 239); this file is its public API.
export { RestoreFailure } from "./failures";
export type { RestoreFailureCode } from "./failures";
export {
  quoteName,
  databaseName,
  urlFor,
  scratchName,
  dropDatabase,
} from "./database";
export { locateBackup, restoreInto, migrationsFolder } from "./source";
export type { SourceInput } from "./source";
export { verifyRestoredData } from "./verify";
export {
  clearStaleAccess,
  announceRestore,
  runRestore,
  promoteRestore,
} from "./run";
export type { RestoreRun, RestoreResult } from "./run";
export {
  REPORT_STATE,
  DRILL_STATE,
  recordDrill,
  readDrillStatus,
  refreshDrillAlert,
} from "./drill";
