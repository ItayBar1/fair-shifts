import { existsSync } from "node:fs";
import { resolve } from "node:path";

// These are public route names, never arbitrary request path segments (#120).
const requestPaths = new Set([
  "/api/v1/actions",
  "/api/v1/state",
  "/api/v1/my-assignments",
  "/api/v1/imports",
  "/api/v1/imports/template",
  "/api/auth/request-code",
  "/api/auth/verify-code",
  "/api/auth/recovery",
  "/api/auth/sign-in/social",
  "/api/auth/callback/google",
  "/api/auth/sign-out",
]);
const methods = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);
const errorNames = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "URIError",
  "EvalError",
  "AggregateError",
  "DrizzleQueryError",
  "DatabaseError",
]);

// Kept in sync with the action dispatcher by the diagnostics unit test. A
// syntactically valid but unknown type can still contain a name or identifier.
export const diagnosticActionTypes = new Set([
  "import.restore.preview",
  "import.restore",
  "import.preview",
  "import.get",
  "import.apply",
  "import.invitations.publish",
  "technical.user.create",
  "soldier.create",
  "soldier.update.preview",
  "soldier.update",
  "soldier.delete.preview",
  "soldier.delete",
  "soldier.timeline.preview",
  "soldier.timeline",
  "eligibility.catalog.save",
  "soldier.timeline.edit.preview",
  "soldier.timeline.edit",
  "soldier.conditions.preview",
  "soldier.conditions",
  "rank.catalog.save",
  "rank.rule.save",
  "rank.deadline",
  "rank.set",
  "rank.approve",
  "round.create",
  "round.close",
  "round.reopen",
  "constraint.submit",
  "constraint.preview",
  "constraint.review",
  "dutyType.save",
  "dutyType.impact.preview",
  "duty.create",
  "duty.assign",
  "duty.assignment.preview",
  "duty.lottery",
  "duty.lottery.approve",
  "planning.run",
  "planning.step",
  "duty.publish",
  "duty.publish.preview",
  "duty.publish.batch",
  "duty.change.create",
  "duty.change.save",
  "duty.change.rules",
  "duty.change.preview",
  "duty.change.publish",
  "duty.change.apply",
  "duty.cancel",
  "duty.change.discard",
  "transfer.offer",
  "transfer.respond",
  "transfer.withdraw",
  "transfer.review",
  "transfer.decide",
  "swap.offer",
  "swap.respond",
  "swap.withdraw",
  "swap.review",
  "swap.decide",
  "cancellation.submit",
  "cancellation.withdraw",
  "cancellation.reject",
  "cancellation.refer",
  "cancellation.prepare",
  "score.preview",
  "score.apply",
  "performance.correction.preview",
  "performance.correction.apply",
  "execution.preview",
  "execution.apply",
  "score.decision.preview",
  "score.decision.apply",
  "account.role",
  "manager.return.keep",
  "account.responsibility",
  "account.unlock",
  "account.email.request",
  "account.email.confirm",
  "technical.email.request",
  "technical.email.confirm",
  "manager.email.request",
  "technical.manager-email.request",
  "manager.email.confirm",
  "technical.manager-email.confirm",
  "notification.read",
  "notification.hide",
  "settings.save",
  "settings.reset",
  "notification.defaults.save",
  "calendar.switch",
  "calendar.remove.future",
  "backup.request",
]);

// Better Auth 1.7.6: oauth2/errors, oauth2/link-account, oauth2/state and callback.
// OAuth provider input and all future/unknown codes become "other".
const googleRejectionCodes = new Set([
  "signup_disabled",
  "account_not_linked",
  "unable_to_link_account",
  "state_not_found",
  "state_mismatch",
  "state_invalid",
  "internal_server_error",
  "invalid_callback_request",
  "invalid_code",
  "no_code",
  "oauth_provider_not_found",
  "issuer_missing",
  "issuer_mismatch",
  "nonce_binding_missing",
  "unable_to_get_user_info",
  "no_callback_url",
  "email_does_not_match",
  "account_already_linked_to_different_user",
  "email_not_found",
  "email_not_verified",
  "unable_to_update_account",
  "unable_to_create_user",
  "unable_to_create_session",
]);

function sourceLocation(error: unknown): string {
  if (!(error instanceof Error) || typeof error.stack !== "string")
    return "unknown";
  // Inspect frames only: an error message may itself contain a fake src path.
  for (const frame of error.stack.split("\n")) {
    if (!/^\s+at\s/.test(frame)) continue;
    const match = frame.match(
      /(?:[/\\( ]|^)(src[/\\][A-Za-z0-9_./\\[\]-]+\.[cm]?[jt]sx?):([1-9]\d*):[1-9]\d*(?:\)|$)/
    );
    if (!match) continue;
    const path = match[1].replaceAll("\\", "/");
    if (path.split("/").some((part) => part === "." || part === "..")) continue;
    // A forged stack cannot emit a personal value disguised as a source file.
    if (existsSync(resolve(path))) return `${path}:${match[2]}`;
  }
  return "unknown";
}

export type RequestDiagnostics = {
  request?: Pick<Request, "method" | "url">;
  actionType?: unknown;
};

/** One English line; never serialize the exception or the request. */
export function logRequestFailure(
  error: unknown,
  context: RequestDiagnostics = {}
) {
  const name =
    error instanceof Error && errorNames.has(error.name)
      ? error.name
      : "unknown";
  const method =
    context.request && methods.has(context.request.method)
      ? context.request.method
      : "unknown";
  let path = "unknown";
  try {
    const candidate = new URL(context.request?.url ?? "").pathname;
    if (requestPaths.has(candidate)) path = candidate;
  } catch {
    /* Missing/invalid URLs supply no diagnostic content. */
  }
  const action =
    path === "/api/v1/actions" && context.actionType !== undefined
      ? ` action=${typeof context.actionType === "string" && diagnosticActionTypes.has(context.actionType) ? context.actionType : "other"}`
      : "";
  console.error(
    `Request failed ${name} ${method} ${path}${action} at ${sourceLocation(error)}`
  );
}

/** Some OAuth rejections never call the library logger. Read only the code of
 * its final callback redirect, never log a location, description or arguments. */
export function logGoogleRejection(request: Request, response: Response) {
  if (
    request.method !== "GET" ||
    new URL(request.url).pathname !== "/api/auth/callback/google"
  )
    return;
  const location = response.headers.get("location");
  if (response.status < 300 || response.status >= 400 || !location) return;
  // A caller may put ?error=... in a successful callbackURL. A newly issued
  // session is success, irrespective of that query. Cookie contents stay private.
  if (
    response.headers
      .getSetCookie()
      .some((cookie) =>
        /^(?:__Secure-)?better-auth\.session_token=[^;]/.test(cookie)
      )
  )
    return;
  let code: string | null;
  try {
    code = new URL(location, request.url).searchParams.get("error");
  } catch {
    return;
  }
  if (code === null) return;
  console.warn(
    `Google sign-in rejected ${googleRejectionCodes.has(code) ? code : "other"}`
  );
}
