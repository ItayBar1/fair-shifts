/**
 * Every address the Workspace answers (#197). The server answers any other
 * address with a 404 before the Workspace loads, so a new screen is added here
 * as well as to its navigation link and to tests/e2e/screens-sweep.spec.ts.
 * Who may open a screen is still decided by the Workspace and the server.
 */
const screens = new Set([
  "/",
  // The fairness table's old address (decision 220).
  "/manage/scores",
  "/calendar",
  "/my-assignments",
  "/fairness",
  "/constraints",
  "/requests",
  "/notifications",
  "/settings",
  "/me",
  "/manage",
  "/manage/account",
  "/manage/soldiers",
  "/manage/eligibility",
  "/manage/ranks",
  "/manage/constraints",
  "/manage/catalog",
  "/manage/planning",
  "/manage/publish",
  "/manage/imports",
  "/manage/audit",
  "/technical",
  "/technical/permissions",
  "/technical/account",
  "/technical/locked",
  "/technical/recovery",
  "/technical/mail",
  "/technical/backups",
  "/technical/audit",
]);
// Screens of one record, linked from mail, notices and the audit log.
const records = [
  /^\/duties\/[^/]+$/,
  /^\/manage\/audit\/[^/]+$/,
  /^\/manage\/publish\/run\/[^/]+$/,
];

export const isWorkspacePath = (path: string) =>
  screens.has(path) || records.some((pattern) => pattern.test(path));
