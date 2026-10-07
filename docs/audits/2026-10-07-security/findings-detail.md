# Fair Shifts — פירוט ממצאים מאושרים (run-1)

מסמך זה נגזר מ־`findings.json` לאחר אימות עצמאי כפול. תוכן הרשומות באנגלית כפי שנכתב בידי המאמתים; כל השחזורים בוצעו בארגז חול לא מקוון עם נתוני דמה בלבד.

## 1. [MEDIUM] Anonymous caller can lock any account and revoke its sessions until manual release, and relock it right after each release

`auth/otp-anonymous-account-lockout`

**תיאור.** An unauthenticated client that knows an account's invitation email can lock that account. It needs no cookies, only the exact Origin header. It sends one POST /api/auth/request-code, then five POST /api/auth/verify-code calls with wrong codes. verifyCode then sets lockedAt, bumps securityEpoch and calls revokeAccess, which deletes all of the victim's sessions and login codes. The account stays unusable until a manual release. A soldier is released by a manager, a manager by the technical account, and the technical account by a one-time recovery code or the server recover CLI. The technical account and both managers, the only principals who can release others, can be locked the same way. Each release goes through revokeAccess and deletes the login code, so the 60-second resend gate does not apply and the attacker can relock at once with the same six requests. Google sign-in is no bypass, because the session.create hook refuses a locked account. The attacker learns nothing and gets no access. The impact is persistent denial of sign-in plus forced logout of the targeted accounts, including every account able to release others.

**שורש הבעיה.** verifyCode counts wrong codes per account, whoever submits them (user.failedAttempts). On the fifth failure it moves the whole account into a state that only manual release can clear, and it revokes existing sessions. Nothing ties the failures to the holder of the emailed code or to the session that requested it. The only gate before verifyCode is an exact Origin match, which any non-browser client can set and which the real login page satisfies. better-auth's default limiter (enabled under NODE_ENV=production, 100 requests per 10 s per IP) is far above the six requests needed. PRD 7.1 and decision 116/150 require lock-until-manual-release after five errors. Neither document considers a third party triggering it.

**התנהגות מכוונת.** Five wrong codes should stop guessing against the current challenge, for example by invalidating that code, requiring a new one, or applying a time-bounded backoff. An anonymous party who only knows an email address should not be able to put an account into a state that needs manual release, or revoke its live sessions.

### מסלול במקור

1. `entrypoint` — `src/app/api/auth/[...all]/route.ts:16` (handler): The public auth route checks POSTs only with verifyOrigin (exact Origin header equality), then forwards cookie-less requests for request-code and verify-code to better-auth
2. `propagation` — `src/server/auth/index.ts:170` (verifyUnitCode endpoint): The plugin endpoint takes {email, code} from an unauthenticated body and calls verifyCode with no identity or session binding
3. `propagation` — `src/server/auth/otp.ts:59` (requestCode): Any caller can store a live challenge for an available account. After a release revokeAccess has deleted the old code, so the 60 s resend check at line 47 does not apply
4. `propagation` — `src/server/auth/otp.ts:107` (verifyCode): A wrong code from any caller increments the account-wide failedAttempts counter
5. `propagation` — `src/server/auth/policy.ts:37` (failureResult): The fifth failure returns locked=true (MAX_FAILURES=5)
6. `sink` — `src/server/auth/otp.ts:117` (verifyCode): lockedAt is set and securityEpoch bumped (lines 109-116), then revokeAccess deletes all the victim's sessions and login codes

### ראיות

- `src/server/http.ts:67` — verifyOrigin only compares the Origin header with BETTER_AUTH_URL. It identifies no client and limits no rate
- `src/server/auth/index.ts:59` — The betterAuth config sets no rateLimit, so better-auth defaults apply: enabled only when NODE_ENV=production (Dockerfile:31), 100 requests per 10 s per IP for these paths. The special 3-per-10 s rule covers only /sign-in, /sign-up, /change-password and /change-email (node_modules/better-auth/dist/api/rate-limiter/index.mjs:302-314). Neither bounds a six-request attack
- `src/server/auth/index.ts:132` — The session.create hook refuses an unavailable (locked) account, so Google sign-in cannot bypass the lock
- `src/server/auth/accounts.ts:47` — accountAvailable returns false whenever lockedAt is set, with no time-based expiry
- `src/server/auth/accounts.ts:131` — revokeAccess deletes the login code, so after any release the attacker can request a new code at once and relock
- `src/server/auth/accounts.ts:252` — unlockAccount lets only a manager release a soldier and only the technical account release a manager. Both releasers can be locked the same way
- `src/server/auth/accounts.ts:370` — Technical recovery-code release also calls revokeAccess, so the technical account can be relocked right after each recovery
- `tests/integration/auth.test.ts:135` — An existing function-level test shows five wrong verifyCode calls lock the account, bump the epoch and delete its sessions
- `docs/duty-management-prd.md:532` — PRD 7.1 requires lock until manual release after five errors, counted per account across resends. It does not consider a third party triggering the lock
- `docs/open-decisions.md:225` — Decision 150: a resend does not reset failures and a lock needs manual release. Third-party triggering is not addressed

### תנאים

- `authentication_level`: None. The attacker sends cookie-less requests to the public auth routes
- `data_state`: The attacker must know the target account's invitation email address. Unit members are likely to know managers' addresses. Any target address that is known or guessable works
- `system_configuration`: The Origin header must equal BETTER_AUTH_URL. A non-browser client sets it freely, and the real login page sends it naturally

### שחזור מקומי מוגבל

- **נקודת מבט:** An unauthenticated network client, or a person using the real login page, who knows a target's email address
- **קלט:**
  - `POST /api/auth/request-code  Origin: <BETTER_AUTH_URL>  {"email":"manager@example.invalid"}`
  - `5x POST /api/auth/verify-code  Origin: <BETTER_AUTH_URL>  {"email":"manager@example.invalid","code":"000000x"}`
- **צעדים:**
  1. In the offline sandbox, with synthetic accounts technical@example.invalid and manager@example.invalid, give the manager a live session row
  2. Call the route's exported POST handler (src/app/api/auth/[...all]/route.ts) with cookie-less Requests: one request-code, then five verify-code with a wrong code, each carrying only Origin: http://localhost:3000
  3. Check that the manager row has lockedAt set, failedAttempts=5 and epoch 2, and that no sessions remain
  4. Release the manager with unlockAccount(technical, ...), check that the login code is gone, and repeat the six requests at once
  5. Lock the technical account the same way, release it with a recovery code via POST /api/auth/recovery, and repeat the six requests
  6. Control: a verify-code without the Origin header returns 403 and does not increment failedAttempts
  7. Test file and output: agents/v2-r2/artifacts/anon-lockout.test.ts and agents/v2-r2/artifacts/anon-lockout.log (vitest run audit/anon-lockout.test.ts, 3 passed)
- **תוצאה שנצפתה:** manager attack#1 statuses=200,401,401,401,401,401 lockedAt=true failedAttempts=5 epoch=2 sessions=0; after technical unlock: lockedAt=false loginCodes=0; manager attack#2 (immediately after unlock) statuses=200,401,401,401,401,401 lockedAt=true; technical attack#1 lockedAt=true; technical recovery status=200 lockedAt=false; technical attack#2 lockedAt=true; no-origin verify-code status=403 failedAttempts=0

### חומרה

- סבירות: **medium** — Six unauthenticated requests per account, no credentials or user interaction, and the real login page works too. The attacker must know the target's email. An upstream WAF cannot tell this from a user mistyping a code, and the default per-IP limit is far above the cost.
- השפעה: **medium** — Persistent denial of sign-in and forced logout for chosen accounts, including both managers and the technical account, who are the only releasers. The attacker can relock right after each release. There is no confidentiality or integrity impact, and operators can still use the server recover CLI.
- ודאות: **high** — Reproduced at the route level in the offline sandbox with synthetic accounts, including relock right after both manager and recovery-code releases. Every cited line was re-read. The only uncertainty is whether the owner already accepted this risk, which is not documented and does not change exploitability.

### תיקון מוצע

Unauthenticated code failures should throttle guessing, not lock the account or end its sessions. (1) On the fifth wrong code for a challenge, mark that loginCode used and ask for a new code. Do not set lockedAt, bump securityEpoch or call revokeAccess. (2) Do not reset failedAttempts when a challenge is exhausted. Keep counting wrong codes across challenges until a successful sign-in, a release or a recovery. Each exhausted challenge doubles the wait before requestCode issues another code, starting at 60 s and capped at 24 h. This is required. A fixed 60 s gate with a reset counter would allow about 7,200 guesses a day per account against a 6-digit code, which makes brute-force takeover practical across the unit. With the backoff, an attacker gets about 55 guesses in the first day and 5 a day after that. (3) Configure better-auth rateLimit explicitly with customRules for /request-code and /verify-code, for example 3 and 10 per 60 s. Resolve the client IP from the cloudflared-supplied header (advanced.ipAddress.ipAddressHeaders), which is safe only because production publishes no other ingress. Without this, limits fall back to a shared bucket. (4) Keep unlockAccount and recovery codes for existing locks. Any future manual lock should be an explicit authenticated manager or technical action. Residual tradeoff the owner must accept: an attacker can still delay email-code sign-in for a targeted account by up to the cap. Existing sessions and Google sign-in are unaffected and nothing needs manual release. This changes PRD 7.1 and decisions 116/150, so the owner must record the new policy in the PRD and decision log.

`src/server/auth/policy.ts`

```ts
export const OTP_MAX_COOLDOWN_MS = 86_400_000;
// failedAttempts counts every wrong code since the last successful sign-in, release or recovery.
export function failureResult(previous: number) {
  const count = previous + 1;
  const inChallenge = ((count - 1) % MAX_FAILURES) + 1;
  return {
    count,
    exhausted: inChallenge === MAX_FAILURES,
    remaining: inChallenge >= 3 ? MAX_FAILURES - inChallenge : undefined,
  };
}
// Each exhausted challenge doubles the wait before the next code, up to the cap.
export function resendDelay(failedAttempts: number) {
  const exhausted = Math.floor(failedAttempts / MAX_FAILURES);
  return Math.min(OTP_MAX_COOLDOWN_MS, OTP_RESEND_MS * 2 ** exhausted);
}
```

`src/server/auth/otp.ts`

```ts
function remainingWarning(remaining: number | undefined) {
  if (remaining === 2) return ". נותרו שני ניסיונות לפני ביטול הקוד";
  if (remaining === 1) return ". נותר ניסיון אחד לפני ביטול הקוד";
  return "";
}

// requestCode: the resend gate grows with exhausted challenges.
if (
  old &&
  now.getTime() - old.sentAt.getTime() < resendDelay(person.failedAttempts)
)
  throw new AppError("rate_limit", "יש להמתין לפני בקשת קוד נוסף", 429);

// verifyCode: wrong codes never lock the account or end its sessions.
if (!matchesDigest(digestCode(person.id, code), challenge.digest)) {
  const failure = failureResult(person.failedAttempts);
  await tx
    .update(user)
    .set({ failedAttempts: failure.count })
    .where(eq(user.id, person.id));
  if (failure.exhausted)
    await tx
      .update(loginCode)
      .set({ usedAt: now })
      .where(eq(loginCode.userId, person.id));
  return {
    error: failure.exhausted
      ? "הקוד בוטל אחרי חמישה ניסיונות. יש לבקש קוד חדש"
      : `קוד לא תקין${remainingWarning(failure.remaining)}`,
    locked: false,
  };
}
```

`src/server/auth/index.ts`

```ts
  return betterAuth({
    // ...existing options...
    rateLimit: {
      enabled: true,
      customRules: {
        "/request-code": { window: 60, max: 3 },
        "/verify-code": { window: 60, max: 10 },
        "/recovery": { window: 60, max: 5 },
      },
    },
    // Ingress is only through cloudflared (compose.production.yaml publishes no ports).
    advanced: { ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] } },
```

## 2. [MEDIUM] Unauthenticated code requests can use up the shared daily mail quota and block OTP sign-in for every account

`auth/request-code-mail-quota-exhaustion`

**תיאור.** POST /api/auth/request-code needs no session. For a registered, available address it stores a new login code and queues a priority-0 'login-code' email. The only throttle is one code per account every 60 s. The worker charges every delivered code to one global daily counter: 300 per quota day, with the last 10 kept for code kinds. The attacker's messages are themselves code kinds, so they also use up that reserve. Someone who knows one registered address (any unit member knows their own) can request a code every 61 s and spend the whole day's quota in about 305 minutes. With k addresses it takes about 300/k minutes. From then until the quota day rolls over: no sign-in or email-change code is delivered to anyone, business mail has already been held since 290, and the login page tells every requester that mail is delayed. A local run in the sandbox reproduced this. 300 requests for dummy account A, 61 s apart, were all delivered and brought the quota to 300. A code then requested for unrelated dummy account B was held as quota_waiting, and codeDeliveryDelayed returned true. The attack can be repeated every quota day.

**שורש הבעיה.** The mail quota is one global per-day counter that every code delivery draws from. Code issuance is limited only per target account (OTP_RESEND_MS = 60 s in requestCode). There is no per-account daily cap, no global or per-source budget on code issuance, and no attribution of unauthenticated requesters. The application configures no rate limit of its own. better-auth's default production limiter (100 requests per 10 s per IP) is far above one request per minute. As a result, anonymous traffic for one address can use the whole shared allocation, including the reserve meant to keep sign-in working.

**התנהגות מכוונת.** Decision 177 keeps the last 10 messages of each day for sign-in and address-verification codes so that legitimate users can always sign in. Unauthenticated requests for one or a few addresses should not be able to use up the shared daily quota or the code reserve and deny sign-in codes to other accounts.

### מסלול במקור

1. `entrypoint` — `src/server/auth/index.ts:164` (requestUnitCode): The public better-auth endpoint POST /request-code (allowlisted in src/app/api/auth/[...all]/route.ts:4-11) takes only {email} and calls requestCode. Its only gate is verifyOrigin (src/server/http.ts:63-69), an exact Origin header match that a non-browser client sets freely.
2. `propagation` — `src/server/auth/otp.ts:47` (requestCode): The only limit is a 60 s resend window per account (OTP_RESEND_MS = 60_000, policy.ts:9). After it passes, a new code replaces the previous one.
3. `propagation` — `src/server/auth/otp.ts:63` (requestCode): Queues a priority-0 'login-code' mail with a unique eventKey for each request; enqueueEmail signals the worker at once for code kinds (email.ts:118).
4. `propagation` — `src/server/operations/email.ts:306` (deliverNextEmail): Delivery is refused only when the global day counter reaches 300 for code kinds (quotaAllows). Below that, the attacker's codes are claimed in priority order ahead of all other mail.
5. `sink` — `src/server/operations/email.ts:411` (deliverNextEmail): Each delivered code increments the shared emailQuota.used for the quota day. Once it reaches 300, holdForQuota (line 307) marks all pending mail, including other accounts' codes, as quota_waiting.

### ראיות

- `src/domain/mail-delivery.ts:6` — DAILY_QUOTA = 300 and CODE_RESERVE = 10 (line 8). quotaAllows (lines 21-23) lets code kinds use the reserve, so abusive code requests use it up too.
- `src/server/operations/email.ts:533` — codeDeliveryDelayed returns true for every requester once used >= 300, so the login page shows the delay notice to everyone.
- `src/server/auth/otp.ts:30` — requestCode has no per-account daily cap and no global or per-source budget. Its only check against repeats is the 60 s window at line 47.
- `docs/open-decisions.md:508` — Decision 177 (user decision) sizes the 10-message code reserve for legitimate waves. It does not cover code requests from someone abusing the endpoint.
- `src/server/auth/index.ts:59` — The betterAuth options (lines 59-212) set no rateLimit and no per-endpoint rule. better-auth's default in production is 100 requests per 10 s per IP, held in memory (node_modules/better-auth/dist/context/create-context.mjs:170-175), which does not limit one request per minute.
- `agents/v3/artifacts/v3-quota.test.ts:55` — Sandbox reproduction, offline with in-container PostgreSQL and an injected counting transport. 300 requestCode/deliverNextEmail pairs for dummy A, 61 s apart within one quota day, raised emailQuota.used one at a time to 300 in 305 simulated minutes. Dummy B's code was then held (status pending, error quota_waiting), deliverNextEmail returned idle, and requestCode(B) returned mailDelayed: true. Output is in agents/v3/artifacts/v3-quota-run.log.

### תנאים

- `authentication_level`: No authentication is needed. The requester must send an Origin header equal to BETTER_AUTH_URL, which any non-browser client can do.
- `data_state`: The attacker must know at least one registered, available (not locked, not deleted) account address. Any unit member's own address is enough. Each extra known address cuts the time to exhaustion proportionally.
- `timing_dependency`: With one address, about 300 requests at 61 s intervals (about 5 hours) are needed within one quota day (MAIL_QUOTA_TIME_ZONE, UTC by default). The effect lasts until the quota day rolls over and can be repeated every day.
- `network_routing`: No application-level control prevents it. A deployment-level rate rule at Cloudflare for POST /api/auth/request-code is not visible in source. Only an unusually strict per-source rule, combined with an attacker unable to rotate source addresses, would raise the cost.
- `third_party_dependency`: Mail goes out through Brevo with MAIL_TRANSPORT=brevo. The denial comes from the application's own 300/day counter whatever the provider plan, and on a Brevo Free account the same traffic also uses up the provider's daily allowance.

### שחזור מקומי מוגבל

- **נקודת מבט:** An unauthenticated client on the internet that knows one registered account address, such as a unit member's own email.
- **קלט:**
  - `POST /api/auth/request-code
    Origin: <BETTER_AUTH_URL origin>
    Content-Type: application/json

{"email":"<registered address>"} (repeated every 61 s)`

- **צעדים:**
  1. Local reproduction: /Users/admin/security-audit-skill/fair-shifts/run-1/sandbox.sh v3 'node_modules/.bin/vitest run audit/v3-quota.test.ts --no-file-parallelism' (test file agents/v3/artifacts/v3-quota.test.ts, output agents/v3/artifacts/v3-quota-run.log).
  2. Create two dummy soldier accounts, A (dummy-a@example.invalid) and B (dummy-b@example.invalid), with createInvitedAccount.
  3. At injected time t0 (after the DB's real now, within one quota day) call requestCode(A, t0) and deliverNextEmail(countingTransport, t0). Check that a second request for A at t0+30 s fails with 429 (the per-account window works).
  4. For i = 1..299 call requestCode(A, t0 + i*61 s) and then deliverNextEmail(countingTransport, same time). Check that each returns {status:'sent'} and that emailQuota.used rises by exactly one.
  5. At the next second call requestCode(B, t) and deliverNextEmail(countingTransport, t). Stop at the first held code.
- **תוצאה שנצפתה:** All 300 codes for A were delivered and emailQuota.used for the quota day reached 300 after 305 simulated minutes. After that, codeDeliveryDelayed returned true and requestCode(B) returned {success:true, mailDelayed:true}. deliverNextEmail returned {status:'idle'}, and B's login-code outbox row stayed pending with error quota_waiting, so it was not delivered.

### חומרה

- סבירות: **medium** — Reachable without authentication. The only requirement is one registered address, which every unit member has. The attack is a trivial script at 1 request per minute, below better-auth's default per-IP limit. The attacker must keep it running about 5 hours per address, or less with several addresses, and a deployment-side rule might add friction.
- השפעה: **medium** — For the rest of the quota day, all OTP sign-in and email-change codes for every account are held, and business notifications stop from 290. Accounts without a live session cannot sign in by code, though Google sign-in if configured, existing sessions and technical recovery codes are unaffected. No data is exposed or changed. The effect clears automatically at the day boundary but can be repeated daily.
- ודאות: **high** — Every trace line was re-read in current source. No application-level bound exists on the path, and the shared-quota exhaustion and cross-account hold were reproduced end to end against the real requestCode and deliverNextEmail code with PostgreSQL in the offline sandbox. The only unverified factor is an external rate rule, which affects likelihood, not the existence of the flaw.

### תיקון מוצע

Bound code issuance separately from the shared mail quota. (1) Add a per-account daily cap on issued login and email-change codes, well below CODE_RESERVE (for example 5 per quota day), counted from email_outbox rows of code kinds for that recipient. (2) Add a global hourly or daily budget for code-kind mail that leaves headroom for other accounts, so that no small set of accounts can use up the reserve. (3) Configure a better-auth customRules entry, or a Cloudflare rule, for /request-code per client IP using the trusted CF-Connecting-IP header. (4) Optionally keep the reserve for accounts that have not yet received a code today. Keep the same answer for registered and unregistered addresses (decision 177), and return the generic success response, not a 429 that reveals registration, when the per-account daily cap is hit.

`src/server/auth/otp.ts`

```ts
// after the 60 s resend check in requestCode
const dayStart = DateTime.fromJSDate(now)
  .setZone(process.env.MAIL_QUOTA_TIME_ZONE ?? "UTC")
  .startOf("day")
  .toJSDate();
const [{ issued }] = await tx
  .select({ issued: sql<number>`count(*)::int` })
  .from(emailOutbox)
  .where(
    and(
      eq(emailOutbox.recipientAccountId, person.id),
      eq(emailOutbox.kind, "login-code"),
      gte(emailOutbox.createdAt, dayStart)
    )
  );
if (issued >= MAX_CODES_PER_ACCOUNT_PER_DAY) return result; // same generic answer, no mail queued
```

## 3. [MEDIUM] A duty manager can take over the other manager's account by changing its login email

`fair-shifts:email-change:manager-peer-account-takeover`

**תיאור.** account.email.request and account.email.confirm accept any soldierId that has a linked, non-deleted account, including a soldier record whose account has role manager. The verification code is sent only to the new address, which the requesting manager chooses. Manager A can therefore move manager B's login email to an address A controls, confirm it with the code A receives, and then sign in as B by OTP. The change revokes B's sessions and Google link, raises B's securityEpoch, and stops B's old address from receiving login codes. The technical account cannot use account.email.* (it is rejected by manager(actor)), and technical.email.* only acts on the technical account itself. So the only ways back are a manager reversing the change, or the technical account removing A's role and promoting a new manager to do it. Sibling paths keep manager accounts out of manager authority: account.unlock on a manager target is technical-only, soldier.delete refuses manager/technical accounts, and decision 250 says a manager does not set another manager's scope. The PRD reserves manager-account administration to the technical account. For the technical account's own address change it requires codes to both the current and the new mailbox, so that whoever holds an open session cannot move the account to their own address. The manager path has no such control for a peer manager account.

**שורש הבעיה.** requestEmailChange and confirmEmailChange in src/server/auth/email-change.ts check only manager(actor) and resolve the target account by user.soldierId = person.id. They never check the target account's role, so a peer manager's account is accepted. The change is proven only by a code delivered to the requester-chosen new address, so it never shows that the account holder approved it.

**התנהגות מכוונת.** The manager email-change path should apply only to accounts whose role is soldier, matching soldier.delete's manager_account guard and the technical-only unlock of manager accounts. Changing a manager account's address should need the technical account or an address-holder-bound flow, such as the dual-code flow of decision 204.

### מסלול במקור

1. `entrypoint` — `src/app/api/v1/actions/route.ts:11` (POST /api/v1/actions): After verifyOrigin and getActor, an authenticated manager session's JSON command is passed to executeAction
2. `propagation` — `src/server/actions.ts:499` (executeAction switch): account.email.request is dispatched straight to requestEmailChange with no target-role guard (account.email.confirm likewise at line 502)
3. `propagation` — `src/server/auth/email-change.ts:42` (requestEmailChange): The target account is selected by user.soldierId = person.id FOR UPDATE. Only its existence and deletedAt are checked, never its role, so a manager account is accepted
4. `propagation` — `src/server/auth/email-change.ts:108` (requestEmailChange): The verification code is enqueued with destination set to the requester-chosen new email only. Nothing is sent to the current address
5. `propagation` — `src/server/auth/email-change.ts:142` (confirmEmailChange): Confirmation again checks only manager(actor) and selects the target by soldierId. It then matches the code the requester received and calls applyVerifiedEmailChange
6. `sink` — `src/server/auth/accounts.ts:429` (applyVerifiedEmailChange): After revokeAccess and deleting the Google account link, it sets user.email to the new address with emailVerified=true and securityEpoch+1. OTP sign-in at the new address then authenticates as the peer manager

### ראיות

- `src/server/auth/email-change.ts:32` — The only authorization in requestEmailChange is manager(actor), and confirmEmailChange has the same at line 128. There is no check of target.role or of target.id against actor.id
- `src/server/actions.ts:487` — Sibling account.unlock lets a manager act only on soldier targets. A manager target requires actor.role === technical
- `src/server/soldier-deletion.ts:117` — Sibling soldier deletion refuses an account whose role is not soldier (manager_account, 403) unless forced
- `src/server/auth/technical-email.ts:30` — The technical account's own address change on the site needs one code to the current address and one to the new address, so that someone holding an open session cannot move the account to their own address. The manager email-change path has no equivalent
- `docs/duty-management-prd.md:526` — Section 7.1: only the technical admin grants or removes manager permission and releases manager accounts. Line 536 scopes the manager path to 'a soldier's email change'
- `docs/open-decisions.md:250` — Decision text: a manager does not set the scope of another manager. Managers do not administer each other's accounts
- `src/server/operations/email.ts:429` — A login-code mail with a null destination is delivered to recipient.email, so after the change B's login codes go to the attacker's address

### תנאים

- `authentication_level`: The attacker holds an authenticated, current manager session (24-hour maximum)
- `authorization_role`: The attacker has role manager. The victim is another manager account linked to a soldier record, which every manager has by design
- `data_state`: The victim's soldier record and account are not deleted. The attacker controls a mailbox not already used by any account. There is no pending email_change on the victim from the last 60 seconds

### שחזור מקומי מוגבל

- **נקודת מבט:** Manager A, one of the unit's duty managers (a malicious insider, or someone holding A's session), wants persistent control of manager B's identity and to lock B out
- **קלט:**
  - `executeAction(managerA, {type:'account.email.request', payload:{soldierId:<B.soldierId>, email:'attacker-of-a@example.invalid', reason:'synthetic'}, expectedVersion:1, idempotencyKey:<uuid>})`
  - `executeAction(managerA, {type:'account.email.confirm', payload:{soldierId:<B.soldierId>, code:<code from the email-change mail sent to attacker-of-a@example.invalid>, disconnectGoogle:true}, expectedVersion:1, idempotencyKey:<uuid>})`
  - `requestCode('attacker-of-a@example.invalid'); verifyCode('attacker-of-a@example.invalid', <login code>)`
- **צעדים:**
  1. In the offline sandbox (--network none, throwaway PostgreSQL with migrations), seed one technical account and two manager accounts A and B, each linked to a synthetic soldier record. Give B a Google link row and a live session row
  2. Controls: as A, call account.unlock on B. As the technical account, call account.email.request on B's soldierId. Both must be rejected
  3. As A, call account.email.request for B's soldierId with an attacker address. Read the code from the email-change outbox row for B's account, then call account.email.confirm
  4. Inspect B's user row, sessions and Google links. Call requestCode for B's old address and for the attacker address, then call verifyCode with the delivered code at the attacker address
  5. Run: sandbox.sh v5 'node_modules/.bin/vitest run audit/v5-peer-manager-email.test.ts --no-file-parallelism' (test file agents/v5/artifacts/v5-peer-manager-email.test.ts, output agents/v5/artifacts/v5-peer-manager-email.log)
- **תוצאה שנצפתה:** The test passed. The control attempts (A unlocking B, and the technical account calling account.email.request) were both rejected. The email-change mail destination was attacker-of-a@example.invalid. B afterwards: {email:'attacker-of-a@example.invalid', role:'manager', emailVerified:true, securityEpoch:2}. B had 0 sessions and 0 Google links. Requesting a code for B's old address and then the attacker address produced exactly one login-code mail, for B's account (destination resolved at delivery to B's current email). verifyCode at the attacker address returned B's user id with role manager and epoch 2.

### חומרה

- סבירות: **low** — Requires one of the unit's two manager accounts: a malicious insider, or someone holding a hijacked manager session of at most 24 hours. Once that is in hand, two ordinary commands with an attacker-chosen mailbox are enough, and the victim does not need to do anything
- השפעה: **high** — Full takeover of a peer privileged identity. The attacker can sign in as B, B's actions and audit entries can be forged, and B is locked out with sessions and Google link revoked. Control of B also survives later removal of A's own manager role. Undoing it requires a manager, or the technical account demoting A and promoting a new manager, because the technical account has no direct address-change path for managers. A gains no unit-data authority beyond what a manager already has. The harm is to identity, accountability and account administration, which the PRD reserves to the technical account
- ודאות: **high** — Every trace line was re-read in the current source. An independent bounded integration test against real PostgreSQL in the offline sandbox reproduced the end-to-end takeover and the sibling controls

### תיקון מוצע

In requestEmailChange and confirmEmailChange, after loading the target account, require target.role === 'soldier', in the same way as soldier.delete's manager_account guard. Then a manager account's address changes only through the technical account or through an address-holder-bound flow with codes to both the current and the new address (a product decision, as in decision 204). Add a regression test: a manager requesting or confirming an email change for another manager's soldierId gets 403, and B's email, securityEpoch, sessions and Google link stay unchanged.

`src/server/auth/email-change.ts`

```ts
invariant(target && !target.deletedAt, "not_found", "חשבון לא נמצא", 404);
invariant(
  target.role === "soldier",
  "manager_account",
  "שינוי מייל של חשבון אחראי נעשה בידי המנהל הטכני",
  403
);
// apply in both requestEmailChange (after line 47) and confirmEmailChange (after line 147)
```

## 4. [LOW] Unauthenticated auth endpoints reveal whether an email is registered and which address is the technical admin

`auth/otp-account-existence-oracle`

**תיאור.** Three unauthenticated endpoints under /api/auth/* answer differently depending on whether an address belongs to an account. (1) request-code: an unknown address always gets 200 {success:true}. An existing, available account gets 429 rate_limit on a second request inside 60 s. The code comment at otp.ts:32 says the function must give 'the same answer for every address, registered or not (decision 177)'. Decision 177 (docs/open-decisions.md:517) and PRD update 1.30 (docs/duty-management-prd.md:59) apply that rule to the login-page mail-delay notice. They reject per-address feedback because it would reveal who is registered. The 429 branch breaks that stated property. (2) recovery: an unknown or non-technical address gets 401 'קוד שחזור לא תקין'. The technical account's address gets 401 'קוד שחזור לא תקין או נוצל'. So one request with any code tells an outsider which email is the technical admin. (3) verify-code: a locked account gets account_locked with role-specific release guidance, which shows whether the account is a soldier, manager or technical account. An unavailable account that is not locked gets 'החשבון אינו זמין לכניסה'. After a request-code, an existing account also gets 'קוד לא תקין' instead of the generic 'קוד לא תקין או שפג תוקפו'. PRD 7.1 (lines 532-534, decision 176) requires the lock and remaining-attempt messages, so item (3) is a design tension for the owner, not a coding defect. Items (1) and (2) were reproduced at the route level against the real Next.js route handler with dummy accounts (artifact agents/v1/artifacts/v1-enum-oracle.log, test agents/v1/artifacts/v1-enum-oracle.test.ts). Effect: an outsider can check candidate emails against the roster and pick out the technical admin's address. Probing request-code sends a real login-code email to each registered address it hits.

**שורש הבעיה.** Each pre-auth branch builds its own status and message. requestCode returns the uniform result only when the account is absent or unavailable. For an existing account inside OTP_RESEND_MS it throws AppError('rate_limit', ..., 429) (otp.ts:47-48). useRecoveryCode uses one message for the unknown and non-technical case (accounts.ts:339-344) and a different one for the technical account with a wrong code (accounts.ts:356). Neither path falls back to one response that looks the same for every address.

**התנהגות מכוונת.** The comment at otp.ts:32 says request-code returns the same answer for every address, registered or not. It cites decision 177, which rejects per-address login-page feedback because it would reveal who is registered. So request-code should return the same status and body for every address. Inside the resend window it should silently skip sending: the one-minute minimum still holds and nothing reveals that an account exists. Recovery should return one identical error for an unknown address, a non-technical address and a wrong or used code for the technical account.

### מסלול במקור

1. `entrypoint` — `src/app/api/auth/[...all]/route.ts:17` (handler): Unauthenticated POSTs to request-code, verify-code and recovery are in the allowlist (lines 4-11). They pass an Origin header equality check (line 16), which a non-browser client sets freely, and then go to getAuth().handler.
2. `propagation` — `src/server/auth/index.ts:168` (requestUnitCode): The /request-code endpoint calls requestCode(email). authOperation maps the AppError with status 429 to APIError TOO_MANY_REQUESTS and keeps the code and message (lines 14-31).
3. `propagation` — `src/server/auth/otp.ts:48` (requestCode): Throws 429 rate_limit only when the user row exists, accountAvailable is true (line 42) and a code was sent less than 60 s ago (line 47). An unknown address returns the uniform result at line 42.
4. `propagation` — `src/server/auth/otp.ts:92` (verifyCode): A locked account returns 'החשבון נעול' plus releaseGuidance(person.role) (lines 19-23), which differs for soldier, manager and technical. No code proof is needed.
5. `propagation` — `src/server/auth/index.ts:205` (recoverUnitAccount): The /recovery endpoint calls useRecoveryCode(email, code) with any code of 1-200 characters.
6. `sink` — `src/server/auth/accounts.ts:356` (useRecoveryCode): For the technical account's address, a wrong code returns 'קוד שחזור לא תקין או נוצל'. An unknown or non-technical address gets 'קוד שחזור לא תקין' (line 342). Both are 401 INVALID_CODE, but the message identifies the technical admin's email.

### ראיות

- `src/server/auth/otp.ts:32` — Code comment states the intended property: 'The same answer for every address, registered or not (decision 177)'. The same function throws 429 only for registered addresses at line 48.
- `docs/open-decisions.md:517` — Decision 177, login-page notice (user decision): the mail-delay notice depends only on system state, and the server returns the same answer to a registered and an unregistered address. The user chose this over per-address feedback, which would reveal who is registered.
- `docs/duty-management-prd.md:59` — PRD update 1.30 repeats the rule: the answer is the same for every address, registered or not, so the login page does not reveal who is registered.
- `src/server/auth/accounts.ts:342` — Generic recovery error for an unknown or non-technical address. It differs from the technical-account wrong-code message at line 356.
- `docs/duty-management-prd.md:534` — PRD 7.1 (decision 176) requires the lock message to say who releases the account, so the role-specific lock text in verify-code is specified behavior. Whether it may show before mailbox proof is an owner decision.
- `src/server/auth/otp.ts:121` — Once an active challenge exists, a wrong code returns 'קוד לא תקין' plus the PRD-required remaining-attempt warning, not the generic message at lines 88 and 106. This is a secondary existence signal and needs a prior request-code.

### תנאים

- `authentication_level`: None. The endpoints are pre-auth. Requests need only an Origin header equal to BETTER_AUTH_URL, which any non-browser client can send.
- `data_state`: The request-code oracle needs the probed account to exist and be available (not locked, deleted or released). The first probe sends a real login-code email to that address. The recovery oracle needs only that the probed address belongs to the technical account and that the account is not deleted.
- `timing_dependency`: The request-code oracle needs the second request within 60 s (OTP_RESEND_MS) of the first.

### שחזור מקומי מוגבל

- **נקודת מבט:** An unauthenticated outsider who can reach the public /api/auth/* routes and has a list of candidate email addresses.
- **קלט:**
  - `POST /api/auth/request-code {"email":"<candidate>"} sent twice within 60 s with header Origin: <BETTER_AUTH_URL>`
  - `POST /api/auth/recovery {"email":"<candidate>","code":"xxxxxxxxxxxxxxxxxxxx"} with header Origin: <BETTER_AUTH_URL>`
  - `POST /api/auth/verify-code {"email":"<candidate>","code":"000000"} with header Origin: <BETTER_AUTH_URL>`
- **צעדים:**
  1. In the offline sandbox (in-container PostgreSQL with migrations applied), create dummy accounts technical@example.invalid (technical), manager@example.invalid (manager) and soldier@example.invalid (soldier) with createInvitedAccount.
  2. Call the exported POST from src/app/api/auth/[...all]/route.ts with Origin http://localhost:3000. Send request-code twice for nobody@example.invalid and twice for soldier@example.invalid.
  3. Call recovery with a wrong 20-character code for nobody@, soldier@ and technical@example.invalid.
  4. Call verify-code with code 000000 for nobody@, and for soldier@ before and after a request-code. Set lockedAt on the three dummy accounts and call verify-code again.
  5. Run: sandbox.sh v1 'node_modules/.bin/vitest run audit/v1-enum-oracle.test.ts --no-file-parallelism' (artifact v1-enum-oracle.test.ts; the responses are written to v1-enum-oracle.log).
- **תוצאה שנצפתה:** request-code: nobody@ returned 200 {"success":true} twice. soldier@ returned 200, then 429 {"code":"rate_limit","message":"יש להמתין דקה בין שליחות קוד"}. recovery: nobody@ and soldier@ returned 401 {"code":"INVALID_CODE","message":"קוד שחזור לא תקין"}, and technical@ returned 401 {"code":"INVALID_CODE","message":"קוד שחזור לא תקין או נוצל"}. verify-code: nobody@ and soldier@ without a challenge returned the same 401 invalid_code 'קוד לא תקין או שפג תוקפו'. soldier@ after request-code returned 401 'קוד לא תקין'. The locked manager, technical and soldier accounts returned three different account_locked messages, each naming the role-specific release path. All 3 vitest assertions passed.

### חומרה

- סבירות: **medium** — Unauthenticated, no special interface, one or two requests per candidate address. The request-code probe sends a login email to each registered target, so it is noisy. The recovery probe is silent and needs one request.
- השפעה: **low** — It shows whether an email belongs to the roster and which address is the technical admin. Lock messages also show account role and lock state. The code comment and the rationale of decision 177 say registration must not be revealed. The leak helps targeted phishing or deliberate lockout, but it grants no access, session or data.
- ודאות: **high** — Every cited line was re-read, and the differences were reproduced at the HTTP route-handler level with dummy accounts in the offline sandbox. The intent comes from an explicit code comment and the rationale of decision 177. The only owner-dependent part is the PRD-mandated lock guidance, which is left out of the core claim.

### תיקון מוצע

Make the pre-auth responses independent of whether the account exists. In requestCode, return the same uniform result inside the resend window instead of throwing 429. The one-minute minimum still holds because no new code is sent. In useRecoveryCode, use one message for an unknown address, a non-technical address and a wrong or used code. Update the e2e assertion in tests/e2e/access-lifecycle.spec.ts:252, which expects the old message. Ask the owner whether the PRD-required role-specific lock guidance and remaining-attempt warnings may show before mailbox proof, or should be replaced by one generic 'account unavailable' message, and record the decision. Add an integration test that checks identical status and body for registered and unregistered addresses. A small timing difference remains, because registered addresses do extra database and outbox work. Accept it or equalize it.

`src/server/auth/otp.ts`

```ts
if (old && now.getTime() - old.sentAt.getTime() < OTP_RESEND_MS) return result; // same answer as an unknown address (decision 177); no new code is sent
```

`src/server/auth/accounts.ts`

```ts
invariant(recovery, "INVALID_CODE", "קוד שחזור לא תקין", 401);
```

## 5. [LOW] Managers whose service has ended keep receiving manager-only alert emails about other soldiers

`fair-shifts/manager-alert-mail-ignores-recipient-service-end`

**תיאור.** When a manager's own service ends, accountAvailable refuses the account on every request. The account still keeps role='manager' and deletedAt=null until another manager deletes the linked soldier, and decision 170 leaves that deletion as a later manager choice. Three staff-alert producers pick recipients by role and deletedAt only: announceDepartures, the soldier-deletion alert and announceRestore. deliverNextEmail checks only that the recipient exists, deletedAt and the preference for the 'departure', 'deletion' and 'restore' kinds. So a former member whose access ended at release keeps getting unit personnel data at their mailbox. Departure mail carries another soldier's name, last service day and flagged-assignment count. Deletion mail carries the deleted soldier's name and seat counts. Restore mail carries restore notices. The site notification for the same event is unreachable because the account is refused, so email is the only channel that leaks. Round and duty-reminder mail already re-check access at delivery. Independent local reproduction: artifact agents/v12/artifacts/v12-departed-manager-alert.log, harness agents/v12/artifacts/v12-departed-manager-alert.test.ts.

**שורש הבעיה.** Recipient selection for manager alerts uses only role and deletedAt: src/server/departures.ts:74-77, src/server/soldier-deletion.ts:641-645 (role only, then !deletedAt) and src/server/operations/restore.ts:718-723. The delivery-time check in src/server/operations/email.ts:328-333 does the same for these kinds. None of them applies the service-end access rule (canAccessAfterService, through accountAvailable or hasAccess). The request path applies that rule (accounts.ts:54), and so do the round and duty-reminder relevance checks.

**התנהגות מכוונת.** Decision 170 (docs/open-decisions.md:399) sends the departure notice to every active manager. Decision 169 (docs/open-decisions.md:382) says a person who no longer has access because of release receives no notice. A manager whose linked soldier fails canAccessAfterService should be excluded when the alert is created. Any queued staff alert to such a recipient, or to one no longer in a staff role, should be skipped at delivery as not_relevant.

### מסלול במקור

1. `entrypoint` — `src/worker.ts:59` (unit-maintenance job): The scheduled minute's maintenance calls announceDepartures(tx, now) under system authority, inside unitTransaction.
2. `propagation` — `src/server/departures.ts:62` (announceDepartures): Loads every auth_user row as a candidate recipient once a newly departed soldier is found.
3. `propagation` — `src/server/departures.ts:74` (announceDepartures recipient filter): Keeps row.role === 'manager' && !row.deletedAt && row.soldierId !== person.id. There is no check of the recipient's own service end, so a departed but undeleted manager stays a recipient.
4. `propagation` — `src/server/departures.ts:86` (announceDepartures enqueueEmail): Queues a 'departure' email whose body has the subject soldier's name, last service day and flagged count, with a 24 h expiry.
5. `propagation` — `src/worker.ts:74` (drainMail): After commit the worker drains the outbox through deliverNextEmail.
6. `propagation` — `src/server/operations/email.ts:328` (deliverNextEmail recipient check): Loads the recipient and skips only when it is missing or deletedAt is set (line 333). Relevance checks exist only for login-code, round and duty-reminder kinds (lines 342-378), not for departure, deletion or restore. Only preferences are checked after that.
7. `sink` — `src/server/operations/email.ts:444` (deliverNextEmail transport call): Sends the message to recipient.email, the departed manager's address, through the transport (Brevo in production).

### ראיות

- `src/server/auth/accounts.ts:54` — accountAvailable refuses a soldier-linked account once canAccessAfterService is false. This is the access rule the alert recipients bypass.
- `src/server/auth/accounts.ts:129` — revokeAccess, which runs for the departing manager's own account at departures.ts:64-65, deletes sessions and login codes and cancels only login-code mail. It changes neither role nor deletedAt, so the account stays a 'manager' recipient.
- `src/server/departures.ts:76` — The recipient filter is row.role === 'manager' && !row.deletedAt && row.soldierId !== person.id, with no service-end check.
- `src/server/operations/email.ts:333` — For these kinds, the only recipient condition at delivery is `recipient && !recipient.deletedAt`.
- `src/server/round-recipients.ts:126` — Sibling control: round mail re-checks receives(), which uses canAccessAfterService, at delivery time.
- `src/server/duty-reminder-checks.ts:56` — Sibling control: duty reminders require hasAccess(person, now) at delivery. hasAccess (line 12) wraps canAccessAfterService.
- `src/server/soldier-deletion.ts:644` — Variant: deletion alert recipients are selected by eq(user.role, 'manager') and then !deletedAt, and queued as kind 'deletion' with the deleted soldier's name and seat counts.
- `src/server/operations/restore.ts:722` — Variant: restore announcement recipients are selected by role in (manager, technical) and deletedAt null only.
- `docs/open-decisions.md:399` — Decision 170: the departure notice goes to every active manager.
- `docs/open-decisions.md:382` — Decision 169: a person without access because of release receives no notice.

### תנאים

- `data_state`: A manager account whose linked soldier's releaseDate has passed (Israel local boundary), so accountAvailable is false, and whose linked soldier no manager has deleted yet. Decision 170 makes deletion a later manager decision, so this state is normal and can last indefinitely.
- `data_state`: A later event produces a manager alert: another soldier's departure, a soldier deletion that vacates or leaves seats, or a restore. The recipient's departure, deletion or restore preference must be on, which is the default.
- `system_configuration`: Mail transport is enabled (MAIL_TRANSPORT=brevo in production) and the recipient address is not a reserved address.

### שחזור מקומי מוגבל

- **נקודת מבט:** The recipient takes no action. A former manager, now an ex-member whose system access ended at release, passively receives unit personnel data at the personal email address stored on the account.
- **קלט:**
  - `agents/v12/artifacts/v12-departed-manager-alert.test.ts: truncate tables; invite FORMER-MGR (manager, 01201), ACTIVE-MGR (manager, 01202), SUBJECT-SOLDIER (soldier, 01203); set FORMER-MGR releaseDate = Israel today-10; announceDepartures + drain; set SUBJECT-SOLDIER releaseDate = Israel today-1; announceDepartures; drain deliverNextEmail with an injected in-memory transport`
- **צעדים:**
  1. In the offline sandbox (fresh PostgreSQL, migrations applied), run: sandbox.sh v12 'node_modules/.bin/vitest run audit/v12-departed-manager-alert.test.ts --no-file-parallelism'.
  2. The harness creates two dummy managers and one dummy soldier, gives FORMER-MGR a releaseDate 10 days in the past, runs announceDepartures inside unitTransaction, and drains the outbox.
  3. It reads FORMER-MGR's auth_user row and calls accountAvailable on it.
  4. It sets SUBJECT-SOLDIER's releaseDate to yesterday, runs announceDepartures again, lists the departure outbox rows for FORMER-MGR, and drains them with an injected transport, recording recipient, subject and whether the body names SUBJECT-SOLDIER.
- **תוצאה שנצפתה:** V12_FORMER {role:'manager', deletedAt:null, available:false}; V12_QUEUED_FOR_FORMER [{kind:'departure', status:'pending'}]; V12_DELIVERED_TO_FORMER [{to:'01201@example.invalid', subject:'סיום שירות', namesSubject:true, eventKey:'departure'}]; V12_ALL_RECIPIENTS ['01201@example.invalid','01202@example.invalid']. 1 test passed (log: agents/v12/artifacts/v12-departed-manager-alert.log). The deletion and restore variants were confirmed from source only.

### חומרה

- סבירות: **medium** — No attacker action is needed. A departed but undeleted manager is a normal, retained lifecycle state under decision 170. Every later departure, qualifying deletion or restore then triggers the mail, with preferences on by default. The precondition depends on one of the unit's few managers reaching release before being deleted.
- השפעה: **low** — The disclosure is limited to other soldiers' names, last service days, seat and flag counts, and restore notices. It goes to a former manager who was authorized for similar data before release. No write, session or authority is gained.
- ודאות: **high** — Every trace and evidence line was re-read at commit c4a1e01. An independent bounded local run showed accountAvailable=false for the former manager while a departure email naming another dummy soldier was delivered to that manager's address. No other layer (revokeAccess, superseded, preferences) blocks it. Sibling mail kinds enforce the missing rule, and the decision log says 'active manager'.

### תיקון מוצע

Apply the service-end access rule to staff-alert recipients in both layers. At creation, exclude soldier-linked staff whose linked soldier fails hasAccess/canAccessAfterService. This covers announceDepartures, the soldier-deletion alert and announceRestore; a technical account without soldierId stays eligible. At delivery, add a relevance check for the departure, deletion and restore kinds: the recipient's current role must still be manager (or technical for restore), and a soldier-linked recipient must still pass hasAccess. Otherwise skip with 'not_relevant'. Add regression tests: a departed, undeleted manager receives no departure, deletion or restore mail, and mail queued before a manager departs or is demoted is skipped at delivery.

`src/server/departures.ts`

```ts
const peopleById = new Map(people.map((p) => [p.id, p]));
for (const recipient of accounts.filter(
  (row) =>
    row.role === "manager" &&
    !row.deletedAt &&
    row.soldierId !== person.id &&
    (!row.soldierId || hasAccess(peopleById.get(row.soldierId), now))
)) {
```

`src/server/operations/email.ts`

```ts
const STAFF_KINDS = ["departure", "deletion", "restore"];
if (!skip && STAFF_KINDS.includes(message.kind)) {
  const staffRoles =
    message.kind === "restore" ? ["manager", "technical"] : ["manager"];
  if (!staffRoles.includes(recipient.role)) skip = "not_relevant";
  else if (recipient.soldierId) {
    const [person] = await tx
      .select()
      .from(soldiers)
      .where(eq(soldiers.id, recipient.soldierId));
    if (!hasAccess(person, now)) skip = "not_relevant";
  }
}
```

## 6. [LOW] Withdrawn transfer/swap offers still send their mail and drain the unit's shared daily mail quota

`fair-shifts/seat-offer-mail-sent-after-withdrawal`

**תיאור.** A soldier who holds a reserved seat in a published duty can run transfer.offer (up to 20 candidates) and then transfer.withdraw, over and over. swap.offer/swap.withdraw works the same way, with up to 20 target seats. Each offer queues one 'transfer'-kind email per recipient. Withdrawing never cancels those outbox rows, and deliverNextEmail has no relevance check for this kind, so every mail for a withdrawn offer is still delivered and counted against the shared Brevo daily quota (290 non-code messages). Withdrawal closes the request, so the same seat can be offered again right away, and there is no per-soldier limit. About 15 cycles of 20 recipients use up the non-code quota. After that, publication digests, change mail and other non-code mail for the whole unit are held as quota_waiting until the next quota day. Withdrawn-offer mail still pending stays deliverable for up to 24 hours (or until the duty starts), so it also takes quota on the next day. Verifier v4 reproduced this independently for both the transfer and the swap path, against a real publication digest.

**שורש הבעיה.** notifySoldier queues offer mail at offer time, bounded only by an expiry (src/server/seat-requests.ts:63-74). withdrawTransfer and withdrawSwap only update the request record (src/server/transfers.ts:694, src/server/swaps.ts:881) and never cancel the queued rows, unlike round notices (round-notices.ts:155) or duty changes (duty-changes.ts:758). Before it charges quota (email.ts:409-411), deliverNextEmail re-checks relevance only for login-code, round-opening/closing, duty-reminder, the publication digest and publication supersession (email.ts:342-390). Kind 'transfer' only gets the recipient and preference checks. Offers have no per-soldier rate limit.

**התנהגות מכוונת.** The PRD says the duty, account and preference state is checked before every send (docs/duty-management-prd.md:627). The helper's contract says offer mail is sent only while it is still relevant (seat-requests.ts:32). So mail for a request that is no longer open should be cancelled, or skipped as not_relevant at delivery, and should never use quota. Mail volume triggered by one soldier should not be able to starve the whole unit's publication mail.

### מסלול במקור

1. `entrypoint` — `src/server/actions.ts:334` (executeAction case transfer.offer): An authenticated soldier's POST /api/v1/actions command is dispatched to offerTransfer. swap.offer (line 349) and swap.withdraw (line 355) are dispatched the same way.
2. `propagation` — `src/server/transfers.ts:225` (offerTransfer): For each of up to 20 deduplicated, non-blocked candidates (schema max 20 at line 136), notify(..., email: true) is called with expiresAt = duty start.
3. `propagation` — `src/server/seat-requests.ts:63` (notifySoldier): enqueueEmail is called with kind 'transfer', priority 1, expiry min(now+24h, expiresAt) and eventKey '<scope>:<requestId>:offer:<accountId>'. The key is new for every request, so the conflict dedupe never merges cycles.
4. `propagation` — `src/server/transfers.ts:694` (withdrawTransfer): The request is set to cancelled and pending candidates to closed. The queued offer mail is not touched. withdrawSwap at swaps.ts:881 is the same.
5. `propagation` — `src/server/operations/email.ts:342` (deliverNextEmail): Relevance checks cover only login-code, round, duty-reminder, digest and publication supersession. A 'transfer' message passes once the recipient exists and the transfer preference is on (the default).
6. `sink` — `src/server/operations/email.ts:411` (deliverNextEmail): The shared daily quota is charged and the withdrawn-offer mail is handed to the transport. At 290, codesOnly (lines 310-311) holds all later non-code mail as quota_waiting.

### ראיות

- `src/server/seat-requests.ts:32` — Helper contract: mail of the swaps-and-transfers type is sent 'while it is still relevant'.
- `src/server/swaps.ts:104` — The swap notify wrapper calls the same notifySoldier with scope 'swap', so the withdrawn-swap path is the same.
- `src/server/seat-requests.ts:128` — seatCommitted is only given open requests (openSeatRequests, line 106, used at transfers.ts:177), so a seat whose offer was withdrawn can be offered again right away.
- `src/domain/mail-delivery.ts:21` — quotaAllows: non-code mail stops at DAILY_QUOTA - CODE_RESERVE = 290.
- `src/server/operations/email.ts:322` — The outbox is ordered by priority, then createdAt. Transfer mail (priority 1) queued earlier is sent before publication mail (also priority 1) queued later.
- `src/server/round-notices.ts:155` — Same-codebase contrast: round notices cancel their pending outbox rows when they become irrelevant. Seat requests have no equivalent.
- `docs/duty-management-prd.md:627` — Requirement: the current duty, account and preference state is checked before every send.

### תנאים

- `authentication_level`: An authenticated soldier account (not a manager).
- `data_state`: The attacker holds a reserved seat in a published duty that has not ended. The recipients are other soldiers with accounts who are not blocked by eligibility (transfer), or holders of published seats (swap), and they have the transfer email preference on (the default).
- `system_configuration`: Real mail transport is enabled (MAIL_TRANSPORT=brevo) with the shared Brevo Free daily quota of 300 and a code reserve of 10.

### שחזור מקומי מוגבל

- **נקודת מבט:** An authenticated soldier holding one published seat, acting through POST /api/v1/actions.
- **קלט:**
  - `{"type":"transfer.offer","payload":{"assignmentId":"<own seat>","candidateIds":["<c1>","<c2>","<c3>"]},"expectedVersion":<seat version>,"idempotencyKey":"<uuid>"}`
  - `{"type":"transfer.withdraw","payload":{"id":"<request id>"},"expectedVersion":<request version>,"idempotencyKey":"<uuid>"}`
  - `{"type":"swap.offer","payload":{"assignmentId":"<own seat>","targetAssignmentIds":["<other soldier's published seat>"]},"expectedVersion":<seat version>,"idempotencyKey":"<uuid>"}`
  - `{"type":"swap.withdraw","payload":{"id":"<request id>"},"expectedVersion":<request version>,"idempotencyKey":"<uuid>"}`
- **צעדים:**
  1. In the offline sandbox (harness agents/v4/artifacts/v4-withdrawn-offer-mail.test.ts, run with: sandbox.sh v4 'node_modules/.bin/vitest run audit/v4-withdrawn-offer-mail.test.ts --no-file-parallelism'; output in agents/v4/artifacts/v4-withdrawn-offer-mail.log), create one manager and six synthetic soldiers. Publish duty X (+3 days) with the offerer assigned and duty Y (+10 days) with soldier s1 assigned, then clear the setup outbox.
  2. Phase A, fresh quota: transfer.offer to s2, s3 and s4, then transfer.withdraw. Then swap.offer targeting s1's seat in Y, then swap.withdraw. Run deliverNextEmail with an injected fake transport until it returns idle.
  3. Phase B: set today's email_quota.used to 288 (2 non-code sends left). Run transfer.offer to s2-s4 followed by transfer.withdraw twice. The manager then creates, assigns and publishes duty Z for s5, which queues a real publication-digest. Call deliverNextEmail at now + 11 minutes, after the digest window closes, until idle, and read email_outbox and email_quota.
- **תוצאה שנצפתה:** Phase A: both requests are 'cancelled', yet the fake transport received 3 'transfer:<req>:offer:<acct>' mails and 1 'swap:<req>:offer:<acct>' mail, and quota used = 4. Phase B: both requests are 'cancelled', and 6 transfer mails plus 1 publication-digest were queued. The transport received 2 withdrawn-offer mails, quota used reached 290 (the non-code limit), and the real publication-digest stayed pending with error quota_waiting. 4 withdrawn-offer mails remained pending.

### חומרה

- סבירות: **medium** — Any soldier with a published seat can do it with two ordinary commands per cycle, about 15 cycles of 20 recipients, and no rate limit. Every action is audited under the actor's identity, and recipients get visible spurious offer mail, so it is easy to attribute.
- השפעה: **low** — Non-code email for the whole unit (publication digests, changes) is delayed until the next quota day, and recipients get spurious offer mail. Login and verification codes keep their 10-message reserve, site notifications are unaffected, and no data or authority is gained.
- ודאות: **high** — The root cause is direct in source. Verifier v4 independently reproduced it in the offline sandbox for both the transfer and the swap path, with real withdraw commands and a real publication-digest held as quota_waiting.

### תיקון מוצע

Cancel pending offer mail when a seat request closes (withdraw, decline, expire, complete, closeSeatRequests). As defence in depth, re-check relevance at delivery for kind 'transfer': skip as not_relevant unless the referenced request is still open and the recipient's entry is still pending. Consider a modest per-soldier daily cap on offers.

`src/server/operations/email.ts`

```ts
if (
  !skip &&
  message.kind === "transfer" &&
  !(await seatRequestMailRelevant(
    tx,
    message.eventKey,
    message.recipientAccountId
  ))
)
  skip = "not_relevant";
// seatRequestMailRelevant: parse '<scope>:<requestId>:<event>:<account>'; for event 'offer' require records(kind='request', id=requestId).data.status === 'awaiting_consent' and the recipient's candidate entry still 'pending'.
```

`src/server/transfers.ts`

```ts
// in withdrawTransfer (and withdrawSwap, expire, closeSeatRequests, decline/complete paths): after updateRecord
await tx
  .update(emailOutbox)
  .set({ status: "cancelled", error: "not_relevant", updatedAt: new Date() })
  .where(
    and(
      eq(emailOutbox.status, "pending"),
      like(emailOutbox.eventKey, `${scope}:${row.id}:offer:%`)
    )
  );
```

## 7. [LOW] Stored import preview keeps a deleted soldier's superseded contact details

`fair-shifts:soldier-deletion:command-results-superseded-contact-residue`

**תיאור.** eraseCommandResults finds stored command results only by substring search for the soldier id and the contact values that are current when the soldier is deleted. A create-mode import.preview result has no soldier id, because the soldier does not exist yet (imports.ts:394). It does hold the workbook's name, personal number, email, phone and address. Suppose every contact value in that row is later superseded: phone and address through soldier.update, email through the verified account.email change. Then deletion leaves the result in command_results unchanged. No code purges command_results; the only uses are the insert and lookup in actions.ts and the erasure update. Replaying the manager's idempotency key returns the old contact data after deletion. Local reproduction artifacts: agents/v6/artifacts/v6-superseded-contact.test.ts and agents/v6/artifacts/v6-superseded-contact.log.

**שורש הבעיה.** needlesOf(soldierId, contact) (erasure.ts:351, called at soldier-deletion.ts:584) builds needles from the soldier id and the current soldier_contacts row only. Historical identifiers already exist in the soldier's own records, and the same transaction erases them without first adding them as needles: import_row.values (subjectId set by import.apply) and audit_detail changes[].before/after from soldier.update. The create-mode preview result never carries the soldier id, so a match depends on a current contact value still appearing in it.

**התנהגות מכוונת.** PRD line 566 (decision 194) lists what is removed from every active copy. This includes contact details in import rows and stored command results that mention the soldier. Name and personal number are kept only on the soldier tombstone and history. The doc comment at soldier-deletion.ts:522-527 says such stored results ("an import preview lists contact details") return only an erasure marker.

### מסלול במקור

1. `entrypoint` — `src/server/actions.ts:151` (executeAction case import.preview): An authenticated manager submits import.preview over POST /api/v1/actions. previewImport (imports.ts:480) plans a create row whose soldierId is undefined (imports.ts:394) and returns values with email, phone and address.
2. `propagation` — `src/server/actions.ts:536` (executeAction): The full preview result is inserted into command_results under (actor.id, idempotencyKey). No code ever purges it.
3. `propagation` — `src/server/auth/email-change.ts:187` (confirmEmailChange): A verified email change rewrites the login and contact email. soldier.update (people.ts:210) changes phone and address, and the old values go only into an audit_detail record.
4. `propagation` — `src/server/soldier-deletion.ts:584` (eraseSoldier): Needles are built only from the soldier id and the current soldier_contacts email, phone and address.
5. `sink` — `src/server/soldier-deletion.ts:615` (eraseSoldier -> eraseCommandResults): No needle matches the old preview result, so it keeps the old email, phone, address and personal number with no erasedAt marker. actions.ts:135 replays it verbatim on the same key.

### ראיות

- `src/domain/erasure.ts:351` — needlesOf returns only soldierId plus the escaped current email, phone and address.
- `src/server/soldier-deletion.ts:468` — The soldier's own audit_detail and email_change records are deleted, and import_row is scrubbed (line 496), in the same erasure. None of their historical contact values are used as needles first.
- `src/server/soldier-deletion.ts:533` — eraseCommandResults matches rows only by position(needle in result::text) and rewrites the matches to {erasedAt}.
- `src/server/imports.ts:394` — A create-mode planned row has soldierId: person?.id, which is undefined, so the stored preview result never contains the new soldier's id.
- `src/server/actions.ts:135` — When the idempotency key and payload hash match, the stored result is returned verbatim.
- `docs/duty-management-prd.md:566` — Contact details in import rows and stored command results that mention the soldier must be removed from every active copy.

### תנאים

- `data_state`: The soldier was created by import.preview/import.apply. Before deletion, every contact value present in the preview row (email, phone, address) was superseded. If any one value is still current, that needle matches and the result is erased. Verified: changing only the email still erased the result.
- `authorization_role`: In-app read-back is possible only for the manager who issued the preview, by replaying the same idempotency key with the same payload. The residue otherwise sits in the database and its backups.

### שחזור מקומי מוגבל

- **נקודת מבט:** No external attacker. This is a lifecycle failure: a deleted soldier's superseded contact details stay in command_results indefinitely, and the issuing manager can read them back with an idempotent replay.
- **קלט:**
  - `import.preview {filename:'v6-intake.xlsx', rows:[{rowNumber:2, values:{personalNumber:'00888', name:'v6 imported soldier', email:'v6-imported@example.invalid', phone:'0508880001', address:'V6-OLD-ADDRESS-9921'}}]} with a fixed idempotencyKey`
- **צעדים:**
  1. In the offline sandbox, as a synthetic manager, run import.preview with a fixed idempotency key, then run import.apply on the preview.
  2. Run soldier.update on the new soldier with phone 0508880002 and address 'v6 new address'. Then run account.email.request and account.email.confirm to v6-changed@example.invalid, reading the code from the synthetic email_outbox through openSecret.
  3. Run soldier.delete.preview, then soldier.delete for the soldier.
  4. Read command_results for the preview key, and replay import.preview with the same key and payload.
  5. Controls: repeat with no contact change, and with only the email changed.
- **תוצאה שנצפתה:** Case A (all contacts superseded): soldiers.deletedAt was set, and the stored import.preview result had erasedAt=false. It still held the old email, old phone, old address and personal number. The replay returned all three old contact values. Case B (no change): the result was {erasedAt}. Case C (email-only change): the result was erased, because the unchanged phone/address needles matched. All three tests passed (agents/v6/artifacts/v6-superseded-contact.log).

### חומרה

- סבירות: **low** — The soldier must have been created by import, and every contact value in the import row must later change before deletion.
- השפעה: **low** — Superseded contact details (plus name and personal number) stay indefinitely in command_results and backups, against the erasure guarantee. The only in-app reader is the issuing manager, by replaying the exact key and payload, and that manager already had the source workbook.
- ודאות: **high** — I re-read every cited source line and independently reproduced the result through executeAction in the offline sandbox. Positive and two negative controls confirm that erasure fails only when all preview contact values are superseded.

### תיקון מוצע

Before eraseRecords removes them, collect the soldier's historical contact identifiers and add them as escaped needles alongside needlesOf. Sources: import_row.values email/phone/address for rows with subjectId = soldierId, and audit_detail changes[].before/after for phone and address. A sturdier fix links command results to their subjects: store the subject soldier ids on command_results, or rewrite the preview's stored result in import.apply once the soldier id exists, and erase by that link instead of by substring. Add a change-then-delete regression test.

`src/server/soldier-deletion.ts`

```ts
// in eraseSoldier, before eraseRecords(...)
const history = await tx
  .select()
  .from(records)
  .where(
    and(
      eq(records.subjectId, soldierId),
      inArray(records.kind, ["audit_detail", "import_row"])
    )
  );
const escaped = (v: string) => JSON.stringify(v.trim()).slice(1, -1);
const past = history
  .flatMap((r) => {
    const values = (r.data.values ?? {}) as Record<string, unknown>;
    const changes = (r.data.changes ?? []) as {
      field?: string;
      before?: unknown;
      after?: unknown;
    }[];
    return [
      values.email,
      values.phone,
      values.address,
      ...changes
        .filter((c) => c.field === "phone" || c.field === "address")
        .flatMap((c) => [c.before, c.after]),
    ];
  })
  .filter((v): v is string => typeof v === "string" && v.trim() !== "");
const allNeedles = [...new Set([...needles, ...past.map(escaped)])];
// ...
await eraseCommandResults(tx, allNeedles, at);
```

## 8. [LOW] Soldier erasure leaves request decision reasons in other recipients' email_outbox rows

`fair-shifts:soldier-deletion:email-outbox-request-reason-residue`

**תיאור.** When a manager rejects a transfer or swap, the free-text reason is copied into email_outbox rows for both parties (seat-requests.ts notify -> enqueueEmail, event key `<scope>:<requestId>:rejected:<accountId>`). Deleting one party scrubs the request record and every requestId-linked site notification, including the counterpart's notice (body replaced by ERASED_NOTE). eraseSoldier never touches email_outbox rows addressed to other accounts. The counterpart's row keeps the reason. A still-pending row is delivered after the deletion, so the erased text goes to the provider and an external mailbox. After sending, the row keeps its body: delivery clears only encryptedSecret, destination and leaseUntil, and no code purges email_outbox. Every later daily pg_dump backup (only the pgboss schema is excluded) copies the row. Independent reproduction artifact: agents/v7/artifacts/v7-outbox-residue.test.ts with output agents/v7/artifacts/v7-outbox-residue.log.

**שורש הבעיה.** The erasure scope covers the records, assignments and command_results tables, plus the deleted account's own outbox rows. deleteAccountAuth blanks email_outbox only where recipientAccountId equals the deleted account (accounts.ts:304). Mail queued to other accounts that quotes the soldier's request text is never searched, even though its eventKey carries the request id. The parallel site-notice path (eraseRecords plus scrubNotification by requestId) is handled. Mail delivery clears only secret, destination and lease, never the body. The restore residue check (restore.ts:638-645) likewise inspects only the deleted account's pending outbox rows, so the gap is not flagged.

**התנהגות מכוונת.** PRD line 566 lists what is removed from every active copy. It names the reasons the manager wrote in decisions on the soldier's requests, and queued mail. PRD line 558 extends erasure to active copies of the sensitive data in messages. The code's own design treats decisionReason (scrubRequest, erasure.ts:263) and counterpart notices that quote it (scrubNotification by requestId, erasure.ts:336) as erasable. The mail copy of the same text should be scrubbed too, and pending mail cancelled.

### מסלול במקור

1. `entrypoint` — `src/server/transfers.ts:877` (decideTransfer): Manager-only transfer.decide with decision 'reject' and a free-text reason (max 2000). The reason is stored as decisionReason/closedReason and quoted in notify() bodies for both the owner and the accepted replacement (lines 912-937). swaps.ts:1573-1580 does the same for both swap parties.
2. `propagation` — `src/server/seat-requests.ts:64` (notify): Creates a requestId-linked site notification and, while the duty has not ended, enqueues an email with the same body, eventKey `${scope}:${requestId}:${event}:${account.id}`, for the recipient account.
3. `propagation` — `src/server/operations/email.ts:104` (enqueueEmail): Inserts the body verbatim into email_outbox.
4. `propagation` — `src/server/soldier-deletion.ts:611` (eraseSoldier): deleteAccountAuth blanks only the deleted account's own outbox rows. The following eraseRecords, eraseSeatApprovals and eraseCommandResults never read or write email_outbox.
5. `sink` — `src/server/operations/email.ts:457` (deliverNextEmail): The counterpart's pending row, still quoting the erased reason, is claimed and sent after the deletion. The row is then marked 'sent' with only `cleared` (encryptedSecret/destination/leaseUntil, line 190) reset, so the body persists in the live table and in later backups.

### ראיות

- `src/domain/erasure.ts:263` — scrubRequest replaces decisionReason (and closedReason) with ERASED_NOTE: the decision reason is erasable data.
- `src/domain/erasure.ts:336` — scrubNotification erases the site-notice copy of the same text for any recipient linked by requestId. In the reproduction the counterpart's notices were erased while the counterpart's mail was not.
- `src/server/auth/accounts.ts:304` — The outbox scrub in deleteAccountAuth is limited to recipientAccountId = deleted account.
- `src/server/operations/email.ts:190` — `cleared` resets only encryptedSecret, destination and leaseUntil on send. No code path deletes or blanks old email_outbox bodies.
- `src/server/operations/restore.ts:642` — The deleted_soldier_residue check joins email_outbox only to the deleted soldier's own account, so counterpart residue passes.
- `src/server/operations/backup.ts:121` — Backups pg_dump the whole database except the pgboss schema, so email_outbox bodies are copied into each backup.
- `docs/duty-management-prd.md:566` — Erasure must remove the manager's decision reasons on the soldier's requests, and queued mail, from every active copy.

### תנאים

- `data_state`: The deleted soldier was a party to a transfer or swap that a manager rejected with a reason before the duty ended, so mail was enqueued. The counterpart account exists. For post-deletion delivery the row must still be pending and the counterpart's transfer-mail preference on. The body residue in sent rows needs no timing.
- `authorization_role`: A manager performs the rejection and later the deletion (normal product flows). No attacker action is needed.

### שחזור מקומי מוגבל

- **נקודת מבט:** No attacker action is needed. This is a lifecycle failure: after a normal manager deletion, the erased reason stays in an active table and later backups, and a pending copy is still mailed to the counterpart.
- **קלט:**
  - `transfer.decide {decision:'reject', reason:'V7-MARKER-REJECT-REASON-5519'} followed by soldier.delete.preview + soldier.delete of the accepting candidate, then deliverNextEmail with an injected fake transport`
- **צעדים:**
  1. In the offline sandbox with a throwaway PostgreSQL, invite a manager, member and other (synthetic). Publish a duty with other's seat.
  2. other runs transfer.offer to member. Move the duty start 1h into the past (end +1 day). member runs transfer.respond accept, which yields awaiting_manager.
  3. manager runs transfer.decide reject with the marker reason, then soldier.delete.preview and soldier.delete for member.
  4. Query records and email_outbox for the marker. Then call deliverNextEmail(fakeTransport) until idle and check the delivered texts.
  5. Artifact: agents/v7/artifacts/v7-outbox-residue.test.ts, output agents/v7/artifacts/v7-outbox-residue.log.
- **תוצאה שנצפתה:** Before deletion two pending outbox rows quoted the reason: eventKeys transfer:<req>:rejected:<other> and transfer:<req>:rejected:<member>. After deletion 0 records quoted the reason, and both of other's requestId-linked site notices had body == ERASED_NOTE. One email_outbox row addressed to other was still pending and still quoted the reason. deliverNextEmail then sent 2 messages, one of them to other's address quoting the erased reason. That row ended with status 'sent' and its body still contained the reason.

### חומרה

- סבירות: **medium** — Rejecting a transfer or swap with a reason and later deleting a party are ordinary flows in a ~120-soldier unit. The sent-row residue needs no timing. Only post-deletion delivery needs the row to still be pending (within 24h or before duty end).
- השפעה: **low** — The retained text was already shown to the counterpart. The harm is a broken deletion guarantee: the text stays in the live DB and backups, and a pending copy is still delivered externally after erasure, while the matching site notice is erased. Nothing new reaches a lower-trust principal.
- ודאות: **high** — Every cited source location was re-read, and the lineage is complete. An independent sandbox reproduction through the real executeAction dispatcher and deliverNextEmail showed the residue and the post-deletion delivery.

### תיקון מוצע

Extend eraseSoldier to scrub mail that quotes the soldier's requests, not only mail addressed to the deleted account. Outbox event keys carry the request id (transfer:/swap:/execution:<requestId>:<event>:<account>, cancellation:<requestId>:...). Replace those bodies and titles with ERASED_NOTE and cancel any rows still pending or sending, in the same transaction as eraseRecords. Add the same predicate to deletedSoldierResidue in restore.ts. Add a regression test for the transfer and swap reject flows: no email_outbox row contains the reason after deletion, and no reject mail is delivered after deletion.

`src/server/soldier-deletion.ts`

```ts
// imports: add `like` from drizzle-orm, `emailOutbox` from ./auth-schema, ERASED_NOTE from ../domain/erasure
async function eraseRequestMail(
  tx: DbTransaction,
  requestIds: string[],
  at: Date
) {
  if (!requestIds.length) return;
  await tx
    .update(emailOutbox)
    .set({
      body: ERASED_NOTE,
      status: sql`case when ${emailOutbox.status} in ('pending','sending') then 'cancelled' else ${emailOutbox.status} end`,
      encryptedSecret: null,
      destination: null,
      leaseUntil: null,
      updatedAt: at,
    })
    .where(
      or(...requestIds.map((rid) => like(emailOutbox.eventKey, `%:${rid}:%`)))
    );
}
// in eraseSoldier, after eraseRecords:
await eraseRequestMail(
  tx,
  requests.map((row) => row.id),
  now
);
```

## 9. [LOW] Google sign-in racing a verified email change keeps a session or creates a lasting Google link for the replaced address

`src/server/auth/index.ts:databaseHooks:google-link-not-rechecked-under-user-lock`

**תיאור.** A verified email change (manager account.email.confirm, or technical.email.confirm) is the documented way to disconnect Google. applyVerifiedEmailChange locks the user row, deletes all sessions and every auth_account link, writes the new address and bumps securityEpoch (decision 185, docs/open-decisions.md:630). On GET /api/auth/callback/google, Better Auth chooses the target user with unlocked reads: findAccountOwnerByKey by sub, or findUserByEmail on the Google address. The app hooks then create the link and the session without re-checking that choice under the user-row lock. If the email change commits inside that window, two invalid results follow. (A) A callback for the just-disconnected sub still gets a session stamped with the new epoch, and getActor accepts it: 168 h for a soldier; the technical role also reproduced. (B) A Google account verified for the old, replaced address gets a link to the account, even though a second sub was refused while the first link existed. The link lasts: later ordinary sign-ins with that sub succeed, and the real holder of the new address is now refused when linking Google (unable_to_link_account) until another email change. Both were reproduced independently by verifier v10-r2 with a schedule in which the real revocation function commits from a separate task on its own DB connection (artifacts agents/v10-r2/artifacts/v10-oauth-race.test.ts and agents/v10-r2/artifacts/v10-oauth-race.log).

**שורש הבעיה.** Provider sign-ins carry no proof. The session's securityEpoch defaults to 0 (index.ts:134-139), so session.create.before copies whatever epoch is current once it holds the user lock (index.ts:150). It checks only accountAvailable. It never checks that the Google link Better Auth used still exists, or that the address Better Auth matched is still the account's address. account.create.before (index.ts:109-119) does one unlocked check for an existing (userId, providerId) link. It never compares the Google-claimed email with the user's current email read under lock. Better Auth makes the owner/email decision earlier, through unlocked reads (link-account.mjs:80 and :119). Nothing binds that decision to the account state that applyVerifiedEmailChange (accounts.ts:416-437) revokes. The email-code path closes the same gap with createProvenSession (index.ts:41-57); the Google path has no equivalent.

**התנהגות מכוונת.** Once a verified email change commits, no Google identity linked or email-matched before the change may get a session or a link on the account. The next Google link must be made against the new address (decision 185, docs/open-decisions.md:630; email-change.ts:133 requires disconnectGoogle:true, and line 209 records googleDisconnected:true).

### מסלול במקור

1. `entrypoint` — `src/app/api/auth/[...all]/route.ts:17` (handler): GET /api/auth/callback/google is on the public allowlist (line 9) and is forwarded unauthenticated to the Better Auth handler. The Origin check applies only to POST.
2. `propagation` — `node_modules/better-auth/dist/api/routes/callback.mjs:172` (callbackOAuth): After validating state, PKCE and the token exchange, it calls handleOAuthUserInfo with Google's sub and email.
3. `propagation` — `node_modules/better-auth/dist/oauth2/link-account.mjs:119` (handleOAuthUserInfo): Picks the target user with unlocked reads: findAccountOwnerByKey by sub (line 80) or findUserByEmail on the Google address. Then, still unlocked, it either refreshes the existing link (updateAccount, line 225) or creates a new one (linkAccount, line 159).
4. `propagation` — `src/server/auth/accounts.ts:428` (applyVerifiedEmailChange): The concurrent verified email change locks the user row, revokes sessions, deletes all Google links, writes the new email, bumps securityEpoch and commits, between Better Auth's decision and the app hooks.
5. `propagation` — `src/server/auth/index.ts:110` (databaseHooks.account.create.before): Unlocked check that no (userId, providerId) link exists. Once the disconnect has committed no link remains, so a sub matched through the replaced address is allowed. The user's current email is never compared.
6. `sink` — `src/server/auth/index.ts:150` (databaseHooks.session.create.before): Under the user lock it checks only accountAvailable, then stamps the session with the post-revocation epoch (proofEpoch || person.securityEpoch) without checking that a Google link still exists. getActor (index.ts:225-230) accepts the session.

### ראיות

- `src/server/auth/index.ts:134` — Comment and code: a provider sign-in carries epoch 0, 'which proves nothing', so the session inherits whatever epoch is current at line 150.
- `src/server/auth/index.ts:47` — createProvenSession binds email-code sessions to the epoch proven at verification, closing the same race for codes. Google sessions have no equivalent binding.
- `src/server/auth/accounts.ts:428` — applyVerifiedEmailChange deletes every auth_account row as the Google-disconnect step and bumps securityEpoch at line 434.
- `src/server/auth/email-change.ts:133` — Manager confirmation requires disconnectGoogle:true and records googleDisconnected:true (line 209) after calling applyVerifiedEmailChange (line 187).
- `node_modules/better-auth/dist/oauth2/link-account.mjs:159` — linkAccount runs after the unlocked email match at line 119. The app's account.create.before hook is the only gate.
- `src/server/auth/technical-email.ts:273` — The technical account's address change uses the same applyVerifiedEmailChange, so the same window applies to the technical admin.
- `src/server/auth/policy.ts:12` — sessionLifetime: 7 days for a soldier, 1 day for manager and technical. The verifier observed 168 h left on the raced soldier session.

### תנאים

- `timing_dependency`: The verified email change must commit between Better Auth's unlocked lookup or update and the app hooks, a window of a few milliseconds. No lock is held across that window, so the interleaving can happen in production. The attacker cannot see the moment of confirmation and must repeat Google callbacks around it.
- `authentication_level`: Case A: the attacker controls the Google account (sub) that was linked before the disconnect. Case B: the attacker controls a Google account that Google marks email_verified for the old, replaced address, for example the compromised mailbox that prompted the change. No prior link is needed.
- `system_configuration`: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are configured; Google sign-in is optional.
- `data_state`: The target account is available: not locked, deleted, released or in restore mode.

### שחזור מקומי מוגבל

- **נקודת מבט:** Holder of a Google identity tied to an address that a manager or the technical admin is replacing through a verified email change, who repeatedly completes Google sign-in while the change is confirmed.
- **קלט:**
  - `agents/v10-r2/artifacts/v10-oauth-race.test.ts (synthetic soldier v10-old@example.invalid -> v10-next@example.invalid; technical account with the same addresses; Google subs sub-a, sub-t, sub-old-mailbox, sub-new-owner; stubbed https://oauth2.googleapis.com/token returning an unsigned id_token per authorization code)`
  - `Race A schedule: vi.spyOn(internalAdapter,'updateAccount') awaits the original, then starts db.transaction(tx => applyVerifiedEmailChange(tx, uid, NEXT)) on setImmediate and resumes the callback only after it commits`
  - `Race B schedule: the same, with the pause after internalAdapter.findUserByEmail, on an invited account that was never linked`
- **צעדים:**
  1. In the offline sandbox with a throwaway PostgreSQL, set synthetic GOOGLE_CLIENT_ID/SECRET and stub only Google's token endpoint, as tests/integration/google-sign-in.test.ts does.
  2. Control: link sub-a through the real /api/auth/sign-in/social and /api/auth/callback/google handlers, commit applyVerifiedEmailChange sequentially, then check that the earlier session is revoked and sub-a is refused.
  3. Race A: link the sub, pause the next callback after updateAccount, commit the real email change from a separate task, resume, then call getActor with the returned cookie. Repeat for a technical-role account.
  4. Race B: invite an account with no Google link, pause the callback after findUserByEmail(old address), commit the email change, resume. Then sign in again with the same sub without any spy, and try to link a Google account for the new address.
  5. Run: sandbox.sh v10-r2 'node_modules/.bin/vitest run audit/v10-oauth-race.test.ts --no-file-parallelism' (log: agents/v10-r2/artifacts/v10-oauth-race.log)
- **תוצאה שנצפתה:** Control: {revokedActor:null, after:{signedIn:false, error:'signup_disabled'}, links:[]}. Race A (soldier): {fired:true, committed:true, signedIn:true, actorIsMember:true, email:'v10-next@example.invalid', epoch:2, sessionEpochs:[2], sessionHoursLeft:[168], links:[]}. Race A (technical): {committed:true, signedIn:true, actorRole:'technical', links:[]}. Race B: {committed:true, signedIn:true, email:'v10-next@example.invalid', links:[{accountId:'sub-old-mailbox'}], laterActorIsMember:true, legitNewAddress:{signedIn:false, error:'unable_to_link_account'}}. 4/4 tests passed, exit=0. This matches the hunter's independent 3/3 result.

### חומרה

- סבירות: **low** — The attacker must land a Google callback inside a window of a few milliseconds around a confirmation by a manager or the technical admin. That moment is not observable to them, though in the technical flow a holder of the old mailbox does receive the change code and so knows a change is pending. Each attempt needs a fresh Google authorization. Case B also requires a Google account verified for the old address.
- השפעה: **medium** — It defeats the revocation step meant to cut off a compromised or reassigned address. Case A gives the disconnected identity a session accepted by getActor for up to 7 days (soldier) or 1 day (manager/technical; the technical role was reproduced). Case B gives a lasting Google login to the account, which can be a manager or the technical admin, and blocks the legitimate new-address owner from linking Google until the next email change.
- ודאות: **high** — Every trace and evidence line was re-read at commit c4a1e01. Two independent harnesses reproduced both invalid transitions. In each, the real applyVerifiedEmailChange commits on its own connection at a point where no lock is held, so the interleaving can happen in production. The Google stub only replaces the token endpoint, after Better Auth's state and PKCE checks; the server-side decision logic under test is unchanged. The only uncertainty is practical timing, and the likelihood score covers it.

### תיקון מוצע

Bind the Google decision to account state read under the same user-row lock that applyVerifiedEmailChange takes. (1) Store on each Google link the user's email at the moment of linking: a new auth_account column linked_email, declared as an account additionalField with input:false. (2) In account.create.before, open a transaction, lock the user row, delete any Google link whose linked_email differs from the current email, refuse if a current link remains, and refuse unless the Google-claimed email in value.idToken equals the current normalized email; then return the data with linkedEmail set to the current email. (3) In session.create.before, when proofEpoch is 0 (a provider sign-in), refuse unless a Google link exists whose linkedEmail equals person.email under the lock. This also refuses a link inserted in the gap between the account hook's commit and Better Auth's insert. Do not bind the link to securityEpoch: role change, unlock and recovery bump the epoch without disconnecting Google. The hunter's fix imported jose, which is not a direct dependency, and left that insert-gap window open. Add regression tests using the two adapter-pause schedules.

`src/server/auth/index.ts`

```ts
// auth-schema.ts account table: linkedEmail: text("linked_email"), plus a migration adding the column.
// betterAuth({ account: { accountLinking: {...}, additionalFields: { linkedEmail: { type: "string", required: false, input: false } } } })
const claimedEmail = (token?: string | null) => {
  try { const e = JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString()).email; return typeof e === "string" ? normalizeEmail(e) : null; } catch { return null; }
};
// databaseHooks.account.create.before
before: async (value) =>
  db.transaction(async (tx) => {
    const [person] = await tx.select().from(tables.user).where(eq(tables.user.id, value.userId)).for("update");
    if (!person || !(await accountAvailable(person, tx))) return false;
    const scope = and(eq(tables.account.userId, value.userId), eq(tables.account.providerId, value.providerId));
    const [linked] = await tx.select().from(tables.account).where(scope);
    if (linked && linked.linkedEmail !== person.email) await tx.delete(tables.account).where(eq(tables.account.id, linked.id));
    else if (linked) return false;
    if (claimedEmail(value.idToken) !== person.email) return false;
    return { data: { ...value, linkedEmail: person.email } };
  }),
// databaseHooks.session.create.before, after the accountAvailable check, inside the same locked transaction:
if (!proofEpoch) {
  const [link] = await tx.select({ linkedEmail: tables.account.linkedEmail }).from(tables.account)
    .where(and(eq(tables.account.userId, person.id), eq(tables.account.providerId, "google")));
  if (!link || link.linkedEmail !== person.email) return false;
}
```
