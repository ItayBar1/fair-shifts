# Fair Shifts — architecture summary (run-1, commit c4a1e01)

**Product.** Hebrew RTL web app that allocates duty shifts for a ~120-soldier unit. Pre-production: synthetic staging only. Roles `soldier | manager | technical` (`src/server/auth/policy.ts:7`). Soldiers see their own duties, submit constraints, offer transfers/swaps/cancellation requests. Managers (two by design, each also linked to a `soldierId`) manage people, ranks, rounds, duties, lottery/planning, publication, execution and scores, imports and soldier deletion. The technical admin is a separate account (no `soldierId`), changes soldier↔manager roles, unlocks managers, requests backups, sees operations status. Worker (pg-boss) and host CLI operators (bootstrap, recover, technical-email, restore, deletion-log, demo-code) act with direct DB authority. Protected resources: soldier personal data (contacts, exemptions, constraints with reasons, service dates), fairness scores and assignments, account emails/sessions, recovery codes, backups, the deletion log.

**Comparable baseline.** None source-grounded.

**Stack.** TypeScript, Next.js 16.3.6 (one catch-all page + route handlers), React 19, better-auth 1.7.6, drizzle-orm 0.45 on PostgreSQL 18, pg-boss 12, exceljs 4.4, zod 4. Docker images (Postgres base + Node 24 + `age`). Dev `compose.yaml` binds app to 127.0.0.1:3000; `compose.production.yaml` publishes no ports, db on an internal network, `cloudflared` tunnel for ingress, secrets from `${FAIR_SHIFTS_CONFIG_DIR}/*.env`. `scripts/auto-deploy.sh` (systemd timer every minute, docker-group user) fetches `origin/main`, checks CI conclusion through the unauthenticated GitHub API, fast-forwards and runs `scripts/production.sh deploy`. CI `.github/workflows/ci.yml` (push/pull_request, `contents: read`, no secrets). Offline sandbox for this run: `sandbox.sh` (pre-built image, `--network none`, in-container PostgreSQL, vitest unit/integration harnesses).

**Entry surfaces.**

- `POST /api/v1/actions` (`src/app/api/v1/actions/route.ts`): `verifyOrigin` (exact `Origin` == `BETTER_AUTH_URL`, `src/server/http.ts:63`) → `getActor` → `executeAction` (`src/server/actions.ts:106`), one dispatcher over 87 command types inside `unitTransaction` (global lock), idempotency results stored in `command_results` and replayed. Every handler applies its own guard (`manager()`/`technical()` in `src/server/repository.ts:12-27`, or ownership by `actor.soldierId`). No body-size limit on `request.json()`.
- `GET /api/v1/state` → `readState` (`src/server/state.ts`), role projections; soldiers receive all other soldiers' name/score/population/rank and all published assignments.
- `GET /api/v1/my-assignments?mail=` → `readMyAssignments` (`src/server/my-assignments.ts`), writes a feed cursor; no Origin check.
- `POST /api/v1/imports` (manager, 5 MB, exceljs parse in `src/server/import-workbook.ts`, archive pre-check by declared sizes) and `GET /api/v1/imports/template`.
- `/api/auth/*` (`src/app/api/auth/[...all]/route.ts`): allowlist `request-code`, `verify-code`, `recovery`, `sign-in/social`, `callback/google`, `sign-out`; POST Origin check. Custom plugin in `src/server/auth/index.ts`; OTP in `src/server/auth/otp.ts` (6 digits, HMAC, 10 min, 60 s resend, 5 failures lock + epoch bump); recovery codes for the technical account (`src/server/auth/accounts.ts:332`). Google OAuth optional, sign-up disabled, account linking with `requireLocalEmailVerified: false`.
- `GET /api/health` public (version, worker/db status).
- Worker `src/worker.ts`: maintenance, mail delivery (Brevo, text-only, `src/server/operations/email.ts`), backups (`pg_dump | age`, Google Drive or directory storage, `src/server/operations/backup*.ts`), deletion-log replication (`src/server/operations/deletion-log.ts`, unkeyed SHA-256 chain), restore gate.
- CLIs `scripts/*.ts` (operator authority), restore (`src/server/operations/restore.ts`).

**Trust boundaries and strongest controls.**

1. Anonymous → account: OTP/recovery/Google; controls: HMAC digest + lockout + epoch-bound proof (`createProvenSession`), `user.create` hook returns false, single provider link per user.
2. Session → actor: `getActor` reloads role/soldierId from DB and requires `session.securityEpoch === user.securityEpoch` and `accountAvailable`; `assertActorCurrent` re-checks under `FOR UPDATE` per command.
3. Cross-site browser → API: `verifyOrigin` on POSTs only; better-auth cookie defaults (SameSite/Secure depend on `BETTER_AUTH_URL` scheme); `X-Frame-Options DENY`, no CSP.
4. Soldier → other soldiers' data/seats: handler ownership checks; state projection.
5. Manager → manager/technical accounts: `account.email.*` and `soldier.update` lack a target-role check (recon lead); deletion and unlock check target role.
6. Manager upload → server parser/resources: size/entry checks, exceljs.
7. Data lifecycle: erasure (`src/server/soldier-deletion.ts`, `src/domain/erasure.ts`), restore and import-restore, deletion-log replay (`src/server/restore-deletions.ts`), stored copies in `command_results`, outbox, audit.
8. Repo/CI → production host: auto-deploy trusts `origin/main` + GitHub CI result, runs the merged commit's scripts as a docker-group user; rulesets in `.github/rulesets/*.json` (application unverifiable from source).

**Starting paths.** `src/server/actions.ts`, `src/server/auth/`, `src/server/state.ts`, `src/server/my-assignments.ts`, `src/server/transfers.ts`, `src/server/swaps.ts`, `src/server/cancellation-requests.ts`, `src/server/constraints.ts`, `src/server/auth/email-change.ts`, `src/server/people.ts`, `src/server/import-workbook.ts`, `src/server/imports.ts`, `src/server/import-restores.ts`, `src/server/soldier-deletion.ts`, `src/server/operations/`, `src/components/workflows.tsx`, `compose.production.yaml`, `scripts/auto-deploy.sh`, `.github/`.

**Prior coverage.** No prior run or ledger exists; no carried exclusions.

**Companion selection.** WEB-PROTOCOL-AND-AUTH (OTP/recovery/OAuth linking, session invalidation, CSRF, cookies); DATA-ISOLATION-AND-LIFECYCLE (role projections, erasure, backup/restore, import-restore, deletion log); CLIENT-SIDE (stored hrefs, navigation, clickjacking/XSS in React views); RESOURCE-EXHAUSTION (XLSX decompression, unbounded JSON body, pre-auth lockout); SUPPLY-CHAIN-AND-RELEASE and CLOUD-AND-DEPLOYMENT (auto-deploy, CI, compose/Docker, secrets). Excluded: AI-AND-LLM, MEMORY-SAFETY, DESKTOP-MOBILE-IPC, PROTOCOLS-RPC (no such surfaces; pg-boss is internal).
