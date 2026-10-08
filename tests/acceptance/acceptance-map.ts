/**
 * The acceptance map (card #38): for every user story (section 4 of the PRD)
 * and every acceptance scenario (section 9), the automated tests that show it,
 * or the gap that is still open. `tests/unit/acceptance-matrix.test.ts` checks
 * that every file and test title named here exists and that the PRD and this
 * map list the same numbers; `pnpm docs:matrix` renders docs/acceptance-matrix.md.
 *
 * A test is named by the file and a fragment of its title, so a renamed or
 * deleted test breaks the map instead of leaving a claim with no evidence.
 * "covered" means every clause of the story or scenario has a test; "partial"
 * and "open" say in `gap` which clause has none. Results from real providers,
 * the server and the pilot are kept apart in `external`.
 */
export type Evidence = { file: string; title: string };
export type Status = "covered" | "partial" | "open";
export type External = {
  what: string;
  state: "verified" | "pending";
  ref?: string;
};
export type Entry = {
  status: Status;
  evidence: Evidence[];
  /** What no test shows yet. Required unless the entry is covered. */
  gap?: string;
  /** The open card that will close the gap. Required for an open entry. */
  ticket?: number;
  external?: External[];
};

const U = {
  mine: "tests/unit/my-assignments.test.ts",
  audit: "tests/unit/audit-time.test.ts",
  backup: "tests/unit/backup.test.ts",
  calendar: "tests/unit/calendar.test.ts",
  calendarSync: "tests/unit/calendar-sync.test.ts",
  calFilters: "tests/unit/calendar-filters.test.ts",
  composition: "tests/unit/composition.test.ts",
  digest: "tests/unit/assignment-digest.test.ts",
  deletionLog: "tests/unit/deletion-log.test.ts",
  domain: "tests/unit/domain.test.ts",
  eligibility: "tests/unit/eligibility-conditions.test.ts",
  execution: "tests/unit/execution.test.ts",
  fairness: "tests/unit/fairness-table.test.ts",
  filters: "tests/unit/soldier-filters.test.ts",
  importBook: "tests/unit/import-workbook.test.ts",
  lottery: "tests/unit/lottery-draw.test.ts",
  mail: "tests/unit/mail-delivery.test.ts",
  manager: "tests/unit/manager-exclusion.test.ts",
  notifications: "tests/unit/notification-preferences.test.ts",
  picker: "tests/unit/soldier-picker.test.ts",
  rank: "tests/unit/rank-conditions.test.ts",
  rest: "tests/unit/rest-windows.test.ts",
  restore: "tests/unit/restore.test.ts",
  rounds: "tests/unit/round-notices.test.ts",
  service: "tests/unit/service-lifecycle.test.ts",
  erasure: "tests/unit/erasure.test.ts",
  weekend: "tests/unit/weekend-surcharge.test.ts",
} as const;
const I = {
  securityErasure: "tests/integration/security-erasure.test.ts",
  securityMail: "tests/integration/security-mail.test.ts",
  mine: "tests/integration/my-assignments.test.ts",
  access: "tests/integration/access.test.ts",
  calendarSync: "tests/integration/calendar-sync.test.ts",
  calendarGrant: "tests/integration/calendar-grant.test.ts",
  calendarLifecycle: "tests/integration/calendar-lifecycle.test.ts",
  genders: "tests/integration/all-genders.test.ts",
  digest: "tests/integration/assignment-digest.test.ts",
  inactive: "tests/integration/inactivity-normalization.test.ts",
  publish: "tests/integration/publish-drafts.test.ts",
  audit: "tests/integration/audit-log.test.ts",
  auth: "tests/integration/auth.test.ts",
  otp: "tests/integration/otp-protection.test.ts",
  backup: "tests/integration/backup.test.ts",
  cancel: "tests/integration/cancellation-requests.test.ts",
  delExec: "tests/integration/deletion-in-execution.test.ts",
  delLog: "tests/integration/deletion-log.test.ts",
  reminders: "tests/integration/duty-reminders.test.ts",
  exec: "tests/integration/execution-periods.test.ts",
  google: "tests/integration/google-sign-in.test.ts",
  comp: "tests/integration/instance-composition.test.ts",
  intake: "tests/integration/soldier-intake.test.ts",
  mail: "tests/integration/mail-delivery.test.ts",
  signal: "tests/integration/mail-signal.test.ts",
  mgrEx: "tests/integration/manager-exclusion.test.ts",
  notif: "tests/integration/notifications.test.ts",
  planning: "tests/integration/planning.test.ts",
  restore: "tests/integration/restore.test.ts",
  roles: "tests/integration/role-matrix.test.ts",
  rounds: "tests/integration/round-notices.test.ts",
  service: "tests/integration/service-lifecycle.test.ts",
  soldierDel: "tests/integration/soldier-deletion.test.ts",
  staging: "tests/integration/staging-soldiers.test.ts",
  swaps: "tests/integration/swaps.test.ts",
  techEmail: "tests/integration/technical-email.test.ts",
  techIntake: "tests/integration/technical-user-create.test.ts",
} as const;
const E = {
  mine: "tests/e2e/my-assignments.spec.ts",
  access: "tests/e2e/access-lifecycle.spec.ts",
  audit: "tests/e2e/audit-log.spec.ts",
  backups: "tests/e2e/backups.spec.ts",
  cards: "tests/e2e/calendar-cards.spec.ts",
  calendarSettings: "tests/e2e/calendar-settings.spec.ts",
  google: "tests/e2e/google-sign-in.spec.ts",
  cancel: "tests/e2e/cancellation-requests.spec.ts",
  rounds: "tests/e2e/constraint-rounds.spec.ts",
  delExec: "tests/e2e/deletion-in-execution.spec.ts",
  digest: "tests/e2e/assignment-digest.spec.ts",
  reminders: "tests/e2e/duty-reminders.spec.ts",
  conditions: "tests/e2e/eligibility-conditions.spec.ts",
  exec: "tests/e2e/execution-periods.spec.ts",
  first: "tests/e2e/first-duty.spec.ts",
  publish: "tests/e2e/publish-drafts.spec.ts",
  importCreate: "tests/e2e/import-restore-creations.spec.ts",
  importPop: "tests/e2e/import-restore-population.spec.ts",
  comp: "tests/e2e/instance-composition.spec.ts",
  mail: "tests/e2e/mail-operations.spec.ts",
  manager: "tests/e2e/manager-exclusion.spec.ts",
  prefs: "tests/e2e/notification-preferences.spec.ts",
  planning: "tests/e2e/planning-shortfall.spec.ts",
  service: "tests/e2e/service-lifecycle.spec.ts",
  soldierDel: "tests/e2e/soldier-deletion.spec.ts",
  picker: "tests/e2e/soldier-picker.spec.ts",
  swaps: "tests/e2e/swaps.spec.ts",
  transfer: "tests/e2e/transfer-approval.spec.ts",
  techEmail: "tests/e2e/technical-email-change.spec.ts",
  sweep: "tests/e2e/screens-sweep.spec.ts",
} as const;

/** The tests of one file, named by fragments of their titles. */
const t = (file: string, ...titles: string[]): Evidence[] =>
  titles.map((title) => ({ file, title }));
const covered = (evidence: Evidence[], external?: External[]): Entry => ({
  status: "covered",
  evidence,
  external,
});
const open = (
  gap: string,
  ticket: number,
  evidence: Evidence[] = []
): Entry => ({
  status: "open",
  evidence,
  gap,
  ticket,
});

// What was checked against the real provider, server or pilot, from
// config/memory/project-state.md (cards #25, #37 and #36); the rest is pending.
const stagingGoogle: External = {
  what: "כניסה אמיתית ב־Google ב־staging",
  state: "verified",
  ref: "#25",
};
const stagingMail: External = {
  what: "Brevo אמיתי ב־staging: קוד, פרסום, כשל וחזרה",
  state: "verified",
  ref: "#25",
};
const driveDaily: External = {
  what: "Drive אמיתי: גיבוי יומי וידני, הרשאה שבוטלה, כשל רשת, שמירת 30",
  state: "verified",
  ref: "#37",
};
const driveRestore: External = {
  what: "Drive אמיתי: שחזור מגיבוי שהורד ומחיקות אחרי שחזור, ותרגיל בשרת",
  state: "pending",
  ref: "#37",
};
const stagingTechnicalAddress: External = {
  what: "החלפת כתובת החשבון הטכני ב־staging לחשבון הייעודי, ומשלוח קוד אמיתי לשתי הכתובות",
  state: "pending",
  ref: "#90",
};
const stagingTechnicalIntake: External = {
  what: "קליטת משתמש ומינוי אחראי חדש בממשק הטכני ב־staging סינתטי",
  state: "pending",
  ref: "#114",
};
const pilot: External = {
  what: "פיילוט עם שני האחראים ונתוני אמת",
  state: "pending",
  ref: "#39",
};

export const stories: Record<number, Entry> = {
  1: covered([
    ...t(
      E.first,
      "manager invites, assigns and publishes; soldier sees only published duties"
    ),
    ...t(
      I.intake,
      "creates the record, the contact, a zero balance, an invited account and its invitation",
      "refuses a personal number that is taken, and an address that is taken, without a trace",
      "creates one soldier when two managers send the same form at once",
      "refuses a form %s and writes nothing"
    ),
  ]),
  2: covered([
    ...t(
      U.importBook,
      "preserves identifiers and zeros, Israeli calendar dates, explicit false and integer scores",
      "rejects the entire file and returns row, field and value for duplicates and malformed cells",
      "rejects invalid archives, empty templates and excess rows"
    ),
    ...t(
      I.auth,
      "imports a whole reviewed batch, preserving reservations and blank fields with documented balances",
      "rejects all rows on duplicate, conflicting identities, incomplete ranks or deleted people",
      "serializes competing import approvals and returns idempotent results without duplicate ledger entries",
      "restricts import previews and history to managers"
    ),
    ...t(
      I.staging,
      "writes a workbook that the import accepts whole, with the three populations"
    ),
  ]),
  3: covered([
    ...t(
      I.auth,
      "imports a whole reviewed batch, preserving reservations and blank fields with documented balances"
    ),
    ...t(I.intake, "takes an opening balance as the only history"),
  ]),
  4: covered(
    [
      ...t(
        I.auth,
        "does not create an account or send mail for an unknown address"
      ),
      ...t(
        I.google,
        "refuses an uninvited address and an address Google has not verified, creating nothing"
      ),
      ...t(
        I.intake,
        "creates the record, the contact, a zero balance, an invited account and its invitation"
      ),
    ],
    [stagingMail]
  ),
  5: covered(
    [
      ...t(
        I.google,
        "lets an invited person start with Google and then use either Google or an email code"
      ),
      ...t(
        E.google,
        "the Google button gets a Google link from the server, with the server's own permissions"
      ),
      ...t(
        I.auth,
        "consumes a code only once",
        "expires a code at ten minutes"
      ),
      ...t(
        E.access,
        "a refused Google sign-in returns to the login page with guidance, also on a phone"
      ),
    ],
    [stagingGoogle]
  ),
  6: covered([
    ...t(
      I.auth,
      "keeps responsibility a versioned screen default set by the technical account or the manager, never a permission"
    ),
    ...t(
      U.filters,
      "defaults a manager to their responsibility and the shared KAMA group",
      "hides KAMA independently and can add the other population"
    ),
    ...t(
      E.first,
      "responsibility filters default per manager, hide KAMA and filter rank without granting or limiting access"
    ),
  ]),
  7: covered([
    ...t(
      U.domain,
      "moves the population for an earlier officer date or a KAMA transition",
      "treats an officer date after the career date as no move",
      "merges dates that do not change the effective population"
    ),
    ...t(
      I.auth,
      "previews a population transition over a night duty that crosses it, keeps earlier transitions and saves one of two competing confirmations"
    ),
    ...t(
      E.first,
      "population moves preview their impact before saving in the transition, the profile and the import"
    ),
  ]),
  8: covered([
    ...t(
      I.service,
      "grants grace only when marked eligible and leaves the balance when it ends"
    ),
    ...t(
      U.service,
      "applies only to an explicitly eligible soldier",
      "ends on the last day of a shorter month, which is itself available"
    ),
  ]),
  9: covered([
    ...t(
      I.auth,
      "retains an assignment and flags it when a new inactivity period conflicts",
      "previews a new inactivity period that touches only the last day of a duty, saves nothing until confirmation and then flags it in the same save"
    ),
    ...t(I.service, "keeps access during an inactive period"),
    ...t(U.service, "limits assignment but is not an access state"),
  ]),
  10: covered([
    ...t(
      I.service,
      "refuses every request from the local midnight after the release day, before any worker run",
      "announces a departure once to each manager across repeated runs, races and downtime, without deleting"
    ),
    ...t(
      E.service,
      "release blocks the open session at the boundary, the managers get one departure notice and the service dates are shown"
    ),
  ]),
  11: covered([
    ...t(
      I.soldierDel,
      "removes contact details and conditions, and keeps name, number and history",
      "vacates future seats, keeps seats of a duty that started, and warns the managers",
      "ends access and mail at once"
    ),
    ...t(
      E.soldierDel,
      "the manager sees what a deletion does, deletes the user, and the seat becomes vacant with a warning"
    ),
  ]),
  12: covered([
    ...t(
      I.auth,
      "removes an exemption without discarding approved constraints and restricts both preview and catalog edits to managers",
      "requires exemption approval for a partial overlap, rejects an obsolete preview and saves one of two competing confirmations"
    ),
    ...t(
      U.picker,
      "hides the soldier through the last day of the exemption, inclusive"
    ),
  ]),
  13: covered([
    ...t(
      I.auth,
      "previews a shortened qualification for the whole performance, retains the assignment and flags it after explicit confirmation",
      "counts combined qualification periods over the whole duty and clears the attention flag only when they cover it"
    ),
    ...t(U.domain, "checks qualification throughout the execution"),
    ...t(
      U.picker,
      "hides a soldier whose qualification expires, or starts, inside the range"
    ),
  ]),
  14: covered([
    ...t(
      U.rest,
      "also holds when the soldier already has the later duty",
      "allows a duty that starts the minute the other ends, and blocks one minute of overlap",
      "does not count the seat that is being given away"
    ),
    ...t(
      U.domain,
      "does not treat overlapping rest buffers alone as conflicting"
    ),
  ]),
  15: covered([
    ...t(
      I.auth,
      "persists a justified rank exception through another seat assignment and publication",
      "rejects an obsolete exception preview and never permits it to bypass a missing qualification",
      "checks personal hours over a night in Israeli time, keeps them out of the lottery and allows only a justified manual exception"
    ),
    ...t(
      E.first,
      "manager invites, assigns and publishes; soldier sees only published duties"
    ),
  ]),
  16: covered([
    ...t(
      I.auth,
      "allows a manager to reopen a closed round without changing its target period"
    ),
    ...t(
      I.rounds,
      "cancels on closing and starts a new generation on reopening or extension"
    ),
    ...t(
      E.rounds,
      "constraint round: direct declaration, shared decision, stale approval, close and reopen"
    ),
  ]),
  17: covered([
    ...t(
      I.auth,
      "rejects submissions outside the window or target period and applies whole Israel days across a clock change"
    ),
    ...t(
      E.rounds,
      "constraint round: direct declaration, shared decision, stale approval, close and reopen"
    ),
  ]),
  18: covered([
    ...t(
      I.auth,
      "records a no-constraints declaration directly as a completed submission and lets a later item replace it"
    ),
    ...t(
      I.rounds,
      "reminds only soldiers who have not submitted, and rechecks at delivery"
    ),
  ]),
  19: covered([
    ...t(
      I.auth,
      "keeps the approved constraint while an edit awaits review and after its rejection",
      "accepts multiple independently reviewed items atomically and archives changed versions"
    ),
  ]),
  20: covered([
    ...t(
      I.auth,
      "accepts multiple independently reviewed items atomically and archives changed versions",
      "lets one of two managers decide a shared constraint, shows who decided and rejects stale edits"
    ),
  ]),
  21: covered([
    ...t(
      I.auth,
      "keeps the global pending-review confirmation separate from each collision approval",
      "requires a new collision approval for every pending version and never carries it into the approved version"
    ),
    ...t(
      I.planning,
      "stops a confirmed run at a newly pending constraint until a manager confirms again"
    ),
    ...t(
      U.domain,
      "global pending review approval does not waive the individual collision"
    ),
  ]),
  22: covered([
    ...t(
      I.auth,
      "retains an assignment and flags it when a new inactivity period conflicts",
      "requires current impact confirmation and keeps a conflicting assignment for treatment"
    ),
  ]),
  23: covered([
    ...t(
      I.auth,
      "applies updated catalog prices and composition only through an explicit proposal"
    ),
    ...t(
      I.comp,
      "edits a draft's roles and daily pricing, prices each seat once and leaves the catalog and other instances alone"
    ),
  ]),
  24: covered([
    ...t(
      E.first,
      "multi-day duties appear on every Israeli day and month, independent of the browser zone"
    ),
    ...t(
      U.calendar,
      "shows a duty crossing a month in both months, with start and end"
    ),
    ...t(
      I.comp,
      "edits a draft's roles and daily pricing, prices each seat once and leaves the catalog and other instances alone"
    ),
  ]),
  25: covered([
    ...t(
      I.comp,
      "releases an occupied seat of a published instance only when it is chosen explicitly, and only on update and publish",
      "keeps occupied seats before vacant ones when a catalog quota is applied"
    ),
    ...t(
      U.composition,
      "keeps slot ids and occupants, drops vacant slots first and applies role conditions"
    ),
    ...t(
      E.comp,
      "manager reduces an instance's quota, releases a seat explicitly and changes its pricing before update and publish"
    ),
  ]),
  26: covered([
    ...t(
      I.planning,
      "recomputes candidates and the minimum after every seat of one instance"
    ),
    ...t(
      I.auth,
      "plans one seat per transaction, resumes, and leaves missing seats without moving assignments"
    ),
    ...t(
      E.planning,
      "a period plan explains each shortfall, and a changed draw drops its approval form"
    ),
    ...t(
      E.first,
      "manager invites, assigns and publishes; soldier sees only published duties"
    ),
  ]),
  27: covered([
    ...t(
      I.planning,
      "filters blocked candidates before the minimum and keeps the exact strict band"
    ),
    ...t(U.domain, "filters before minimum and uses a strict upper bound"),
  ]),
  28: covered([
    ...t(
      U.lottery,
      "gives every member of the band an equal share of the random range",
      "never reaches a member above the band, even with the highest value"
    ),
    ...t(U.domain, "filters before minimum and uses a strict upper bound"),
    ...t(
      I.planning,
      "filters blocked candidates before the minimum and keeps the exact strict band"
    ),
  ]),
  29: covered([
    ...t(
      I.planning,
      "counts draft and in-execution reservations of both managers in the scheduling score",
      "lets two managers plan overlapping duties at once without booking one soldier twice"
    ),
    ...t(I.auth, "lets only one of two managers occupy the last place"),
    ...t(
      U.domain,
      "counts draft reservations and forbids an automatic zero value selection"
    ),
  ]),
  30: covered([
    ...t(
      I.planning,
      "orders equally scarce duties by nearer start and then a fixed id"
    ),
    ...t(
      I.auth,
      "plans scarce duties before earlier common duties and the rare role first within a duty"
    ),
  ]),
  31: covered([
    ...t(
      I.planning,
      "excludes a rejected near-release candidate only from that duty"
    ),
    ...t(
      I.auth,
      "requires explicit proposal approvals and completes a competing decision only once",
      "does not inherit an earlier near-release approval into a new published version"
    ),
    ...t(
      U.domain,
      "allows a volunteer near release without that approval alone"
    ),
  ]),
  32: covered([
    ...t(
      E.planning,
      "a period plan explains each shortfall, and a changed draw drops its approval form"
    ),
    ...t(
      I.auth,
      "plans one seat per transaction, resumes, and leaves missing seats without moving assignments"
    ),
    ...t(
      I.planning,
      "draws nobody for a zero value seat and reports it as missing in a period plan"
    ),
  ]),
  33: covered([
    ...t(
      I.auth,
      "keeps drafts private, publishes explicitly and settles exactly once",
      "cancels an expired draft explicitly and releases reservations without earning points or revealing it"
    ),
    ...t(
      E.first,
      "manager invites, assigns and publishes; soldier sees only published duties"
    ),
  ]),
  34: covered([
    ...t(
      I.auth,
      "keeps a published duty binding until an atomic versioned update replaces its reservations",
      "applies updated catalog prices and composition only through an explicit proposal"
    ),
    ...t(
      E.comp,
      "manager reduces an instance's quota, releases a seat explicitly and changes its pricing before update and publish"
    ),
  ]),
  35: covered([
    ...t(
      U.calendar,
      "builds a Sunday-first month grid and moves across years",
      "assigns instants near midnight to the Israeli day and month"
    ),
    ...t(
      U.calFilters,
      "upcoming honors personal scope and excludes a duty at its exact end"
    ),
    ...t(
      E.cards,
      "soldier summary cards filter, restore and focus the score at width"
    ),
    ...t(
      E.first,
      "multi-day duties appear on every Israeli day and month, independent of the browser zone"
    ),
  ]),
  36: covered([
    ...t(
      U.fairness,
      "ranks soldiers by balance, with equal balances sharing a rank"
    ),
    ...t(
      U.domain,
      "shares rank at equal scores and only credits published duties"
    ),
    ...t(
      E.cards,
      "soldier summary cards filter, restore and focus the score at width"
    ),
  ]),
  37: covered([
    ...t(
      U.domain,
      "prices 36 actual hours at six points",
      "rounds only after all components have been added",
      "counts an overnight window once and applies its minimum"
    ),
    ...t(
      U.execution,
      "measures real hours across the end of summer time in Israel"
    ),
    ...t(
      I.comp,
      "edits a draft's roles and daily pricing, prices each seat once and leaves the catalog and other instances alone"
    ),
  ]),
  38: covered([
    ...t(
      I.comp,
      "saves a suggested call-up amount on the type and instance without ever applying it by itself"
    ),
    ...t(
      I.exec,
      "requires an explicit fixed-price and bonus split, then credits each performer once"
    ),
    ...t(
      I.auth,
      "keeps the original until consent, moves the full value without a score check and completes once when candidates race"
    ),
  ]),
  39: covered([
    ...t(
      I.auth,
      "applies updated catalog prices and composition only through an explicit proposal"
    ),
    ...t(
      I.comp,
      "edits a draft's roles and daily pricing, prices each seat once and leaves the catalog and other instances alone"
    ),
  ]),
  40: covered([
    ...t(
      I.auth,
      "keeps drafts private, publishes explicitly and settles exactly once"
    ),
    ...t(
      I.exec,
      "splits the daily base by actual time, credits the ended part once and keeps the rest stored"
    ),
    ...t(
      I.delExec,
      "never credits twice when the worker and the manager's decision race"
    ),
  ]),
  41: covered([
    ...t(
      I.auth,
      "rejects a normalization preview after a concurrent balance change without partially applying it",
      "settles overdue work before normalization and serializes a competing worker without double credit"
    ),
    ...t(U.domain, "rounds a 20% reduction of 51 to 41 and clamps at zero"),
    ...t(
      E.first,
      "manager resolves a pending balance decision from the handling center after a correction crosses a normalization"
    ),
  ]),
  42: covered([
    ...t(
      I.auth,
      "settles overdue work before normalization and serializes a competing worker without double credit",
      "records the history but leaves the balance for a manager decision after a normalization, even when the corrected end moves past it"
    ),
  ]),
  43: covered([
    ...t(
      I.auth,
      "records the history but leaves the balance for a manager decision after a normalization, even when the corrected end moves past it",
      "shows the decision in the handling center, keeps the balance once and lets a later correction weigh only the new difference",
      "adjusts with a zero floor or sets the balance once when two managers compete, and rejects obsolete or empty choices"
    ),
  ]),
  44: covered([
    ...t(
      I.exec,
      "requires every moment to belong to one performer or to be marked as not performed",
      "checks a replacement against their own period, and frees the leaving soldier after they left"
    ),
    ...t(
      E.exec,
      "a manager records who covered a started seat, approves a handover, and soldiers see each period"
    ),
  ]),
  45: covered([
    ...t(
      I.auth,
      "keeps the original until consent, moves the full value without a score check and completes once when candidates race",
      "rejects an unsuitable candidate without revealing why and rechecks at acceptance"
    ),
    ...t(
      E.first,
      "a soldier offers a published duty to several replacements and the first consent transfers it"
    ),
  ]),
  46: covered([
    ...t(
      I.google,
      "rejects a link inserted after the hook approved it",
      "rejects a session inserted after its hook approved an epoch",
      "requires a proven epoch even when no Google proof exists",
      "requires a verified current email once for a legacy Google link",
      "refuses direct idToken sign-in"
    ),
    ...t(
      I.otp,
      "burns exactly once in a race",
      "anchors the wait to burning",
      "doubles each burn delay to 24 hours",
      "gives the same code-request response",
      "returns an identical recovery error",
      "does not trust client-provided proxy headers",
      "enforces 60 requests, 300 verifications and 10 recoveries",
      "applies the rate limit at the public authentication route"
    ),
    ...t(
      I.swaps,
      "swaps both seats together with their full value, without a score check, and completes once when two acceptances race",
      "rechecks both sides at acceptance and keeps both seats when one side no longer fits, without revealing the offerer's reason"
    ),
    ...t(
      E.swaps,
      "two soldiers swap seats by consent, and a manager approves a swap that needs an exception"
    ),
  ]),
  47: covered([
    ...t(
      I.auth,
      "lets a volunteer near release take over automatically but never past the release boundary"
    ),
    ...t(
      I.swaps,
      "checks the state after the swap, so overlapping source duties and seats in one duty are not a self-conflict"
    ),
    ...t(
      U.domain,
      "lets a consenting volunteer bypass pending constraints but not approved ones or release"
    ),
  ]),
  48: covered([
    ...t(
      I.exec,
      "goes to a manager, who sets the handover, and the original seat binds until then"
    ),
    ...t(
      I.swaps,
      "sends a swap whose duty started to a manager, who needs a handover time to approve it and may reject it with a visible reason"
    ),
    ...t(
      I.auth,
      "hands an acceptance after the start to a manager without moving the seat"
    ),
  ]),
  49: covered([
    ...t(
      I.cancel,
      "submitting changes neither the seat, the calendar nor reserved points, and is visible only to its owner and managers",
      "completes a removal only through update and publish, frees the seat and its reserved points"
    ),
    ...t(
      E.cancel,
      "a soldier's request changes nothing until the manager removes the seat in update and publish, or rejects it"
    ),
  ]),
  50: covered(
    [
      ...t(
        I.reminders,
        "sends the default 24 and 2 hour reminders once on both channels and nothing after the start"
      ),
      ...t(
        I.mail,
        "retries with growing delays, then fails visibly while the site notice stays"
      ),
      ...t(
        E.reminders,
        "duty reminder: one site notice per time, linked to the duty, on mobile too"
      ),
    ],
    [stagingMail]
  ),
  51: covered([
    ...t(
      I.notif,
      "applies changed unit defaults to inheriting accounts without overriding a saved personal form",
      "rechecks type and timing preferences after scheduling and before delivery"
    ),
    ...t(
      U.notifications,
      "validates type, timing, channels and frequency on the server"
    ),
    ...t(
      E.prefs,
      "unit defaults reach soldiers without personal preferences; a saved personal form and inbox states stay personal"
    ),
  ]),
  52: covered([
    ...t(
      I.notif,
      "keeps the site notification when email is off and never treats delivery as reading",
      "hides and reads only the recipient's copy without changing the duty, assignment or log",
      "shows a notification addressed to a manager only to that manager, even when it concerns a soldier"
    ),
  ]),
  53: covered([
    ...t(
      I.audit,
      "shows when, who, why and what changed, with the effective date only when it differs",
      "identifies a decision of another manager and reaches it from the score ledger",
      "gives soldiers no log and the technical account only operations within its authority"
    ),
    ...t(
      E.audit,
      "a manager reads who did what and why, and reaches it from the soldier and the score ledger",
      "a soldier has no audit log"
    ),
  ]),
  54: covered(
    [
      ...t(
        I.backup,
        "produces a verified copy that is only ciphertext, decrypts and restores the data"
      ),
      ...t(
        I.restore,
        "restores the newest backup into a scratch database, passes every check and leaves the live system as it was"
      ),
      ...t(
        E.backups,
        "technical account sees backup status, failures and alerts, and requests a backup once"
      ),
    ],
    [driveDaily, driveRestore]
  ),
  55: covered([
    ...t(
      I.auth,
      "creates one tenure reminder without promoting and requires an explicit versioned decision",
      "recalculates open reminders on a rule change and never overwrites a manually approved future rank"
    ),
    ...t(
      U.filters,
      "filters an exact rank without treating another track as equivalent"
    ),
    ...t(U.rank, "accepts an exact rank and no other"),
  ]),
  56: covered([
    ...t(
      I.auth,
      "snapshots duty and role rank requirements and checks the confirmed rank at the start"
    ),
    ...t(
      U.rank,
      "blocks another rank in an automatic draw, whatever the score",
      "asks the role's condition as well as the duty's"
    ),
    ...t(U.service, "checks rank at the start only"),
  ]),
  57: covered([
    ...t(
      I.auth,
      "creates one tenure reminder without promoting and requires an explicit versioned decision",
      "recalculates open reminders on a rule change and never overwrites a manually approved future rank",
      "shows missing enlistment data and permits a sourced personal deadline without guessing equivalence"
    ),
  ]),
  58: covered([
    ...t(
      U.rank,
      "accepts an exact rank and no other",
      "accepts any rank in a list",
      "accepts a minimum, the rank itself included",
      "accepts a maximum, the rank itself included",
      "accepts a range with both ends included",
      "takes several clauses as alternatives"
    ),
    ...t(U.picker, "expands rank clauses to the catalog ranks they accept"),
  ]),
  59: covered([
    ...t(
      I.auth,
      "persists a justified rank exception through another seat assignment and publication",
      "rejects an obsolete exception preview and never permits it to bypass a missing qualification"
    ),
    ...t(
      U.domain,
      "routes a volunteer's exemption or rank exception to a manager instead of blocking"
    ),
    ...t(
      U.rank,
      "leaves a manual selection to an explicit exception instead of blocking"
    ),
  ]),
  60: covered(
    [
      ...t(
        I.techIntake,
        "creates an invited identity with zero balance without any manager",
        "grants the existing manager role, revokes old access",
        "refuses soldier and manager actors before validating payload",
        "rejects duplicate identity and normalized email",
        "replays one idempotent result",
        "serializes competing creations",
        "rolls back person, contact, balance and account"
      ),
      ...t(
        "tests/e2e/technical-user-create.spec.ts",
        "technical intake without managers, validation, keyboard and promotion"
      ),
      ...t(
        I.access,
        "rejects managers and soldiers on the server, applies a grant and a removal to an existing connection and records both",
        "keeps the technical account out of soldier records, rankings and role changes"
      ),
      ...t(
        I.roles,
        "makes the technical account read the account again before changing a role"
      ),
      ...t(
        E.access,
        "the technical account grants and removes manager permission, ending the open connection each time"
      ),
    ],
    [stagingTechnicalIntake]
  ),
  61: covered([
    ...t(
      I.access,
      "blocks an existing connection, a provider sign-in and new codes until a manager releases the soldier",
      "sends a locked manager to the technical account, which alone releases it"
    ),
    ...t(
      E.access,
      "a soldier is warned, its code burns without revoking access, and a legacy lock is released by a manager",
      "a locked manager is sent to the technical account, which releases it; a recovery code works once"
    ),
  ]),
  62: covered([
    ...t(
      I.access,
      "points a locked technical account to its recovery codes and lets each code work once",
      "recovers through the server with a recorded reason, ends connections and replaces every earlier code"
    ),
  ]),
  63: covered([
    ...t(
      I.auth,
      "restores unchanged imported fields while preserving later edits and reservations",
      "requires a decision after a field changes and returns to the imported value",
      "requires explicit balance resolution after performance, preserves its ledger and applies once in a race"
    ),
    ...t(
      E.importPop,
      "a restore that moves the population shows its assignments per the chosen decision and flags them after confirmation"
    ),
  ]),
  64: covered(
    [
      ...t(
        I.backup,
        "fails at once with one alert when the encryption key is missing",
        "alerts at once when the Drive grant expired, without retrying",
        "retries an upload failure after 15 minutes and an hour, then alerts once"
      ),
      ...t(
        I.restore,
        "restores the newest backup into a scratch database, passes every check and leaves the live system as it was",
        "is off without backups, waiting while young, ok after a pass and overdue after 100 days"
      ),
    ],
    [driveDaily, driveRestore]
  ),
  65: covered(
    [
      ...t(
        I.techEmail,
        "needs both: one right code and one wrong code changes nothing and says nothing about which was wrong",
        "moves the account: new address verified, connections and the Google link gone, recovery codes kept, and recorded with the reason",
        "moves the account with the code from the new address, ends access and replaces the recovery codes"
      ),
      ...t(
        E.techEmail,
        "the technical account moves itself to a new address with a code from each mailbox"
      ),
    ],
    [stagingTechnicalAddress]
  ),
};

export const scenarios: Record<number, Entry> = {
  1: covered(
    [
      ...t(
        I.google,
        "rejects a link inserted after the hook approved it",
        "rejects a session inserted after its hook approved an epoch",
        "requires a proven epoch even when no Google proof exists",
        "requires a verified current email once for a legacy Google link",
        "refuses direct idToken sign-in"
      ),
      ...t(
        I.google,
        "lets an invited person start with Google and then use either Google or an email code",
        "refuses an uninvited address and an address Google has not verified, creating nothing"
      ),
      ...t(
        I.auth,
        "does not create an account or send mail for an unknown address",
        "expires a code at ten minutes",
        "consumes a code only once"
      ),
    ],
    [stagingGoogle]
  ),
  2: covered([
    ...t(
      I.roles,
      "refuses a role that the command is not for with 403, before reading the payload",
      "keeps contact details out of every state but a manager's",
      "keeps another soldier's exemptions and hours out of a soldier's state",
      "refuses a request from another origin, with or without a session"
    ),
    ...t(I.auth, "rejects forged privileges and makes retries idempotent"),
    ...t(
      I.audit,
      "gives soldiers no log and the technical account only operations within its authority"
    ),
    ...t(E.sweep, "and sees nothing of it"),
    ...t(
      "tests/e2e/browser-security.spec.ts",
      "each HTML response gets a fresh server nonce",
      "the production browser boots normally and blocks injected inline script and eval",
      "public health exposes readiness only"
    ),
  ]),
  3: covered([
    ...t(
      I.auth,
      "keeps responsibility a versioned screen default set by the technical account or the manager, never a permission",
      "lets one of two managers decide a shared constraint, shows who decided and rejects stale edits"
    ),
    ...t(
      E.first,
      "responsibility filters default per manager, hide KAMA and filter rank without granting or limiting access"
    ),
    ...t(
      I.roles,
      "shows both managers the same unit, with a draft that only managers see"
    ),
  ]),
  4: covered([
    ...t(
      U.importBook,
      "preserves identifiers and zeros, Israeli calendar dates, explicit false and integer scores",
      "rejects the entire file and returns row, field and value for duplicates and malformed cells"
    ),
    ...t(
      I.auth,
      "imports a whole reviewed batch, preserving reservations and blank fields with documented balances"
    ),
    ...t(
      I.intake,
      "takes an opening balance as the only history",
      "starts without history, rank, grace or duties"
    ),
  ]),
  5: covered([
    ...t(
      U.domain,
      "uses a calendar month for grace at month end",
      "rejects a nonexistent daylight-saving time and requires disambiguation for a repeated time"
    ),
    ...t(
      U.service,
      "ends on the last day of a shorter month, which is itself available"
    ),
    ...t(
      I.service,
      "grants grace only when marked eligible and leaves the balance when it ends"
    ),
  ]),
  6: covered([
    ...t(
      I.auth,
      "retains an assignment and flags it when a new inactivity period conflicts"
    ),
    ...t(
      I.inactive,
      "cannot be given a duty that overlaps it, and can still sign in",
      "is reached by a normalization like everyone else",
      "keeps the normalized balance when the period ends, and is available again"
    ),
    ...t(I.service, "keeps access during an inactive period"),
    ...t(U.service, "limits assignment but is not an access state"),
  ]),
  7: covered([
    ...t(
      U.domain,
      "moves the population for an earlier officer date or a KAMA transition",
      "checks populations for the entire duty"
    ),
    ...t(
      U.service,
      "requires the duty to fit the population on both sides of a switch"
    ),
    ...t(
      I.auth,
      "previews a population transition over a night duty that crosses it, keeps earlier transitions and saves one of two competing confirmations"
    ),
  ]),
  8: covered([
    ...t(U.domain, "checks qualification throughout the execution"),
    ...t(
      I.auth,
      "requires exemption approval for a partial overlap, rejects an obsolete preview and saves one of two competing confirmations",
      "rejects an obsolete exception preview and never permits it to bypass a missing qualification",
      "removes an exemption without discarding approved constraints and restricts both preview and catalog edits to managers"
    ),
    ...t(
      U.picker,
      "hides the soldier through the last day of the exemption, inclusive"
    ),
  ]),
  9: covered([
    ...t(
      U.rest,
      "allows a duty that starts the minute the other ends, and blocks one minute of overlap",
      "blocks in %s mode, as it does for a consenting replacement",
      "still rests at 03:30 summer time",
      "is free from 04:00 summer time"
    ),
    ...t(
      U.domain,
      "does not treat overlapping rest buffers alone as conflicting"
    ),
  ]),
  10: covered([
    ...t(
      I.planning,
      "excludes a rejected near-release candidate only from that duty"
    ),
    ...t(
      U.service,
      "allows a duty that ends exactly at the boundary and blocks one that runs past it",
      "starts the month before release on the same calendar day, or the last day of a shorter month"
    ),
    ...t(
      U.domain,
      "allows a volunteer near release without that approval alone"
    ),
  ]),
  11: covered([
    ...t(
      U.domain,
      "counts draft reservations and forbids an automatic zero value selection"
    ),
    ...t(
      I.auth,
      "keeps drafts private, publishes explicitly and settles exactly once",
      "cancels an expired draft explicitly and releases reservations without earning points or revealing it"
    ),
    ...t(
      I.planning,
      "counts draft and in-execution reservations of both managers in the scheduling score"
    ),
  ]),
  12: covered([
    ...t(
      I.planning,
      "filters blocked candidates before the minimum and keeps the exact strict band",
      "draws nobody for a zero value seat and reports it as missing in a period plan"
    ),
    ...t(
      U.domain,
      "filters before minimum and uses a strict upper bound",
      "counts draft reservations and forbids an automatic zero value selection"
    ),
    ...t(
      U.lottery,
      "gives every member of the band an equal share of the random range",
      "never reaches a member above the band, even with the highest value"
    ),
  ]),
  13: covered([
    ...t(
      I.planning,
      "recomputes candidates and the minimum after every seat of one instance"
    ),
    ...t(
      I.auth,
      "plans scarce duties before earlier common duties and the rare role first within a duty",
      "plans one seat per transaction, resumes, and leaves missing seats without moving assignments"
    ),
    ...t(
      E.planning,
      "a period plan explains each shortfall, and a changed draw drops its approval form"
    ),
  ]),
  14: covered([
    ...t(
      I.auth,
      "keeps drafts private, publishes explicitly and settles exactly once",
      "keeps a published duty binding until an atomic versioned update replaces its reservations"
    ),
    ...t(I.mail, "sends only the newest published version of a duty"),
    ...t(
      E.first,
      "manager invites, assigns and publishes; soldier sees only published duties"
    ),
  ]),
  15: covered([
    ...t(
      I.auth,
      "rejects submissions outside the window or target period and applies whole Israel days across a clock change",
      "records a no-constraints declaration directly as a completed submission and lets a later item replace it"
    ),
    ...t(
      E.rounds,
      "constraint round: direct declaration, shared decision, stale approval, close and reopen"
    ),
  ]),
  16: covered([
    ...t(
      I.auth,
      "keeps the global pending-review confirmation separate from each collision approval",
      "requires a new collision approval for every pending version and never carries it into the approved version"
    ),
    ...t(
      U.domain,
      "global pending review approval does not waive the individual collision"
    ),
    ...t(
      I.planning,
      "keeps the review confirmation separate from each collision in a period plan"
    ),
  ]),
  17: covered([
    ...t(
      I.auth,
      "keeps the approved constraint while an edit awaits review and after its rejection",
      "records a no-constraints declaration directly as a completed submission and lets a later item replace it"
    ),
    ...t(
      I.rounds,
      "reminds only soldiers who have not submitted, and rechecks at delivery"
    ),
  ]),
  18: covered([
    ...t(
      I.auth,
      "retains an assignment and flags it when a new inactivity period conflicts",
      "requires current impact confirmation and keeps a conflicting assignment for treatment"
    ),
    ...t(
      I.cancel,
      "submitting changes neither the seat, the calendar nor reserved points, and is visible only to its owner and managers"
    ),
  ]),
  19: covered([
    ...t(
      I.auth,
      "applies updated catalog prices and composition only through an explicit proposal",
      "edits a draft and explicitly applies catalog changes without publishing or double reserving points"
    ),
    ...t(
      I.comp,
      "edits a draft's roles and daily pricing, prices each seat once and leaves the catalog and other instances alone"
    ),
  ]),
  20: covered([
    ...t(
      U.domain,
      "prices 36 actual hours at six points",
      "counts an overnight window once and applies its minimum",
      "splits actual daily time and never duplicates a fixed extra",
      "rounds only after all components have been added"
    ),
    ...t(
      U.execution,
      "gives each performer the daily base in proportion to actual time, rounded once at the end"
    ),
  ]),
  21: covered([
    ...t(
      I.comp,
      "saves a suggested call-up amount on the type and instance without ever applying it by itself"
    ),
    ...t(
      I.exec,
      "requires an explicit fixed-price and bonus split, then credits each performer once"
    ),
    ...t(
      I.auth,
      "keeps the original until consent, moves the full value without a score check and completes once when candidates race"
    ),
    ...t(
      I.swaps,
      "swaps both seats together with their full value, without a score check, and completes once when two acceptances race"
    ),
  ]),
  22: covered([
    ...t(
      I.auth,
      "keeps drafts private, publishes explicitly and settles exactly once",
      "cancels an expired draft explicitly and releases reservations without earning points or revealing it",
      "cancels a future published duty atomically, closes proposals and sends one cancellation per affected soldier"
    ),
  ]),
  23: covered([
    ...t(U.domain, "rounds a 20% reduction of 51 to 41 and clamps at zero"),
    ...t(
      I.auth,
      "settles overdue work before normalization and serializes a competing worker without double credit",
      "rejects a normalization preview after a concurrent balance change without partially applying it"
    ),
  ]),
  24: covered([
    ...t(
      I.auth,
      "records the history but leaves the balance for a manager decision after a normalization, even when the corrected end moves past it",
      "previews and applies a value correction once, keeping the draw value and hiding reasons from soldiers",
      "shows the decision in the handling center, keeps the balance once and lets a later correction weigh only the new difference"
    ),
    ...t(
      U.domain,
      "waits for a manager after a barrier or while a decision is open"
    ),
  ]),
  25: covered([
    ...t(
      I.auth,
      "keeps the original until consent, moves the full value without a score check and completes once when candidates race"
    ),
    ...t(
      I.securityMail,
      "cancels old offers when completed but retains valid completion messages for both parties"
    ),
    ...t(
      I.swaps,
      "swaps both seats together with their full value, without a score check, and completes once when two acceptances race"
    ),
    ...t(
      E.first,
      "a soldier offers a published duty to several replacements and the first consent transfers it"
    ),
  ]),
  26: covered([
    ...t(
      I.auth,
      "rejects an unsuitable candidate without revealing why and rechecks at acceptance"
    ),
    ...t(
      I.securityMail,
      "retains a swap offer while another seat for that recipient is pending, then cancels it"
    ),
    ...t(
      I.swaps,
      "rechecks both sides at acceptance and keeps both seats when one side no longer fits, without revealing the offerer's reason",
      "closes the entries of seats that moved or of a duty that changed, and competing moves of a seat end in one outcome"
    ),
  ]),
  27: covered([
    ...t(
      I.exec,
      "splits the daily base by actual time, credits the ended part once and keeps the rest stored",
      "requires an explicit fixed-price and bonus split, then credits each performer once",
      "goes to a manager, who sets the handover, and the original seat binds until then"
    ),
    ...t(
      E.exec,
      "a manager records who covered a started seat, approves a handover, and soldiers see each period"
    ),
  ]),
  28: covered([
    ...t(
      I.cancel,
      "submitting changes neither the seat, the calendar nor reserved points, and is visible only to its owner and managers",
      "is decided once when two managers race, keeps the seat on rejection and hides the decider from the soldier",
      "completes a removal only through update and publish, frees the seat and its reserved points"
    ),
    ...t(
      I.notif,
      "hides and reads only the recipient's copy without changing the duty, assignment or log"
    ),
  ]),
  29: covered([
    ...t(
      I.service,
      "announces a departure once to each manager across repeated runs, races and downtime, without deleting",
      "refuses every request from the local midnight after the release day, before any worker run"
    ),
    ...t(
      I.securityErasure,
      "erases an opaque result by its explicit subject and keeps its replay key and fingerprint"
    ),
    ...t(
      I.soldierDel,
      "vacates future seats, keeps seats of a duty that started, and warns the managers",
      "removes contact details and conditions, and keeps name, number and history"
    ),
  ]),
  30: covered([
    ...t(
      U.calFilters,
      "counts exactly the selected month and keeps cancellations only in the regular view"
    ),
    ...t(
      E.cards,
      "soldier summary cards filter, restore and focus the score at width"
    ),
    ...t(
      U.fairness,
      "ranks soldiers by balance, with equal balances sharing a rank"
    ),
  ]),
  31: covered(
    [
      ...t(
        I.reminders,
        "sends the default 24 and 2 hour reminders once on both channels and nothing after the start"
      ),
      ...t(
        I.rounds,
        "opens once for soldiers serving in the target period, by their preferences",
        "reminds only soldiers who have not submitted, and rechecks at delivery"
      ),
      ...t(
        I.notif,
        "rechecks type and timing preferences after scheduling and before delivery"
      ),
      ...t(
        I.reminders,
        "cancels queued reminders of an old start or a cancelled duty before delivery"
      ),
      ...t(I.mail, "sends only the newest published version of a duty"),
    ],
    [stagingMail]
  ),
  32: covered([
    ...t(
      I.notif,
      "keeps the site notification when email is off and never treats delivery as reading",
      "hides and reads only the recipient's copy without changing the duty, assignment or log"
    ),
    ...t(U.notifications, "counts only unread copies that were not hidden"),
  ]),
  33: covered([
    ...t(
      I.auth,
      "lets only one of two managers occupy the last place",
      "settles overdue work before normalization and serializes a competing worker without double credit",
      "tracks per-field ABA changes and rejects a stale import without changing any row"
    ),
    ...t(
      I.planning,
      "lets two managers plan overlapping duties at once without booking one soldier twice",
      "accepts only one of two managers stepping the same run from the same version"
    ),
    ...t(
      I.roles,
      "makes the second of two managers read again before saving a soldier",
      "makes a manager read the duty again after another manager changed it"
    ),
    ...t(
      E.sweep,
      "in a second tab that the form changed, and shows what was saved"
    ),
  ]),
  34: covered(
    [
      ...t(
        "tests/unit/supply-chain.test.ts",
        "blocks high and critical findings",
        "requires actual approval",
        "fails closed for empty"
      ),
      ...t(
        "tests/unit/repository-rules.test.ts",
        "verifies effective GitHub rules",
        "pins external Docker images"
      ),
      ...t(
        "tests/unit/braces-depth.test.ts",
        "rejects the published stack-exhaustion input"
      ),
      ...t(
        "tests/integration/database-permissions.test.ts",
        "verifies real non-superuser logins",
        "lets pg-boss initialize and work only"
      ),
      ...t(I.auth, "shows worker backup presence to the site"),
      ...t(
        I.mail,
        "retries with growing delays, then fails visibly while the site notice stays"
      ),
      ...t(
        I.backup,
        "produces a verified copy that is only ciphertext, decrypts and restores the data"
      ),
      ...t(
        I.restore,
        "restores the newest backup into a scratch database, passes every check and leaves the live system as it was"
      ),
    ],
    [stagingMail, driveRestore]
  ),
  35: covered([
    ...t(
      E.sweep,
      "is Hebrew, named and fits a phone",
      "without a mouse",
      "when the state cannot load, and recovers on retry"
    ),
    ...t(
      E.picker,
      "the picker works with the keyboard and on a phone without sideways scrolling"
    ),
    ...t(
      U.domain,
      "prices a daytime duty on a clock-change date outside the changed hour",
      "starts a surcharge window at the moment summer time skips its start time"
    ),
    ...t(
      U.execution,
      "measures real hours across the end of summer time in Israel"
    ),
    ...t(
      U.calendar,
      "uses local days across DST changes while the duration stays actual time"
    ),
  ]),
  36: covered([
    ...t(
      U.rank,
      "blocks another rank in an automatic draw, whatever the score",
      "blocks a missing rank as missing information",
      "does not block a soldier with no rank when the duty asks for none"
    ),
    ...t(
      I.auth,
      "snapshots duty and role rank requirements and checks the confirmed rank at the start"
    ),
    ...t(
      U.filters,
      "filters an exact rank without treating another track as equivalent"
    ),
  ]),
  37: covered([
    ...t(U.service, "checks rank at the start only"),
    ...t(
      I.auth,
      "snapshots duty and role rank requirements and checks the confirmed rank at the start",
      "persists a justified rank exception through another seat assignment and publication"
    ),
    ...t(
      U.picker,
      "uses the rank in force on the Israel date the range starts",
      "ignores a later promotion inside the range"
    ),
  ]),
  38: covered([
    ...t(
      I.auth,
      "creates one tenure reminder without promoting and requires an explicit versioned decision",
      "recalculates open reminders on a rule change and never overwrites a manually approved future rank",
      "shows missing enlistment data and permits a sourced personal deadline without guessing equivalence"
    ),
  ]),
  39: covered([
    ...t(
      U.service,
      "allows access through the last day and refuses it from local midnight",
      "uses the winter offset for a release in winter",
      "allows a duty that ends exactly at the boundary and blocks one that runs past it"
    ),
    ...t(
      I.service,
      "applies the boundary at 00:00 Israel time with an explicit clock",
      "refuses every request from the local midnight after the release day, before any worker run"
    ),
    ...t(
      U.domain,
      "expires access after the local release day, independently of a worker",
      "rejects a nonexistent daylight-saving time and requires disambiguation for a repeated time"
    ),
    ...t(
      U.calendar,
      "uses local days across DST changes while the duration stays actual time"
    ),
  ]),
  40: covered([
    ...t(
      U.lottery,
      "gives every member of the band an equal share of the random range",
      "keeps the band in id order whatever the order or the scores of the input"
    ),
    ...t(
      I.planning,
      "orders equally scarce duties by nearer start and then a fixed id"
    ),
    ...t(
      I.auth,
      "plans scarce duties before earlier common duties and the rare role first within a duty",
      "plans one seat per transaction, resumes, and leaves missing seats without moving assignments"
    ),
  ]),
  41: covered([
    ...t(
      I.auth,
      "applies updated catalog prices and composition only through an explicit proposal",
      "requires a new collision approval for every pending version and never carries it into the approved version",
      "requires current impact confirmation and keeps a conflicting assignment for treatment"
    ),
  ]),
  42: covered([
    ...t(
      U.domain,
      "rounds only after all components have been added",
      "rounds a 20% reduction of 51 to 41 and clamps at zero",
      "shares rank at equal scores and only credits published duties"
    ),
    ...t(
      I.planning,
      "draws nobody for a zero value seat and reports it as missing in a period plan"
    ),
  ]),
  43: covered([
    ...t(
      I.auth,
      "records the history but leaves the balance for a manager decision after a normalization, even when the corrected end moves past it",
      "applies a correction to zero with a floor, then treats that clamp as a barrier",
      "settles overdue work before normalization and serializes a competing worker without double credit"
    ),
    ...t(
      U.domain,
      "orders barriers by effective time, not by recording time",
      "names every operation that changes the meaning of a correction"
    ),
  ]),
  44: covered([
    ...t(
      I.auth,
      "keeps the original until consent, moves the full value without a score check and completes once when candidates race",
      "hands an acceptance after the start to a manager without moving the seat"
    ),
    ...t(
      I.swaps,
      "sends a swap whose duty started to a manager, who needs a handover time to approve it and may reject it with a visible reason"
    ),
    ...t(
      I.exec,
      "swaps a started seat at a handover for a whole seat that has not started",
      "goes to a manager, who sets the handover, and the original seat binds until then"
    ),
  ]),
  45: covered(
    [
      ...t(
        I.techIntake,
        "creates an invited identity with zero balance without any manager",
        "grants the existing manager role, revokes old access",
        "refuses soldier and manager actors before validating payload",
        "rejects invalid or out-of-scope identity fields",
        "rejects duplicate identity and normalized email",
        "replays one idempotent result",
        "serializes competing creations",
        "rolls back person, contact, balance and account"
      ),
      ...t(
        "tests/e2e/technical-user-create.spec.ts",
        "technical intake without managers, validation, keyboard and promotion"
      ),
      ...t(
        I.access,
        "rejects managers and soldiers on the server, applies a grant and a removal to an existing connection and records both",
        "keeps the technical account out of soldier records, rankings and role changes"
      ),
      ...t(
        I.roles,
        "makes the technical account read the account again before changing a role",
        "gives the technical account accounts and operations but no soldiers or scores"
      ),
      ...t(
        I.mgrEx,
        "changes the role only for the technical account, and only from a current version"
      ),
      ...t(
        E.access,
        "the technical account grants and removes manager permission, ending the open connection each time"
      ),
    ],
    [stagingTechnicalIntake]
  ),
  46: covered([
    ...t(
      I.access,
      "warns after the third and fourth failure, keeps counting across a resend and burns on the fifth failure without locking",
      "blocks an existing connection, a provider sign-in and new codes until a manager releases the soldier",
      "sends a locked manager to the technical account, which alone releases it",
      "keeps a soldier seven days and managers and the technical account 24 hours, without extending on use"
    ),
    ...t(I.auth, "expires a code at ten minutes"),
    ...t(
      E.access,
      "a soldier is warned, its code burns without revoking access, and a legacy lock is released by a manager"
    ),
  ]),
  47: covered([
    ...t(
      I.auth,
      "rejects all rows on duplicate, conflicting identities, incomplete ranks or deleted people",
      "restores unchanged imported fields while preserving later edits and reservations",
      "cancels a new soldier without activity: removes every trace, frees the number and keeps the row",
      "shows each kind of activity as a conflict, including an edit that was reverted, and closes the batch only when every row is handled"
    ),
    ...t(
      "tests/unit/bounded-body.test.ts",
      "counts streamed action bodies despite a missing or false length"
    ),
    ...t(
      "tests/unit/workbook-archive.test.ts",
      "counts actual bytes even when the directory advertises one byte"
    ),
    ...t(
      "tests/unit/workbook-process.test.ts",
      "contains a parser process crash",
      "kills a parser that exceeds the actual resident-memory limit",
      "kills a stalled parser at the deadline"
    ),
    ...t(
      I.securityErasure,
      "completes the subject links of an import preview after the new soldier is created, then erases its replay content"
    ),
    ...t(
      E.importCreate,
      "cancels a new soldier without activity and waits for a decision on one who signed in"
    ),
  ]),
  48: covered([
    ...t(
      I.soldierDel,
      "removes contact details and conditions, and keeps name, number and history",
      "is removed, while the event and the history stay"
    ),
    ...t(
      I.securityErasure,
      "scrubs historical contact-only results before erasing contact revisions and conservatively scrubs unlinked legacy results",
      "refuses a claimed copy when deletion commits before dispatch begins",
      "serializes erasure with an already-started dispatch and removes the local copy after delivery",
      "detects deleted subjects and counterpart mail in a restored copy, and applies the same erasure rules"
    ),
    ...t(
      I.delExec,
      "stays on the deleted soldier, is not credited by itself, and is urgent for the managers by site and email",
      "is decided by recording the part performed, which is credited once, and a replacement for the rest",
      "never credits twice when the worker and the manager's decision race"
    ),
    ...t(
      I.restore,
      "are applied again from the log before anything of the restored copy is open, and no deleted data returns"
    ),
    ...t(
      E.delExec,
      "the manager finds the urgent item, is offered the part up to the deletion, records a replacement, and the item goes"
    ),
  ]),
  49: covered(
    [
      ...t(
        I.securityMail,
        "saves proposals and site notices beyond 30 recipients, never refunds withdrawal, and shares the budget with swaps",
        "reserves the final recipient only once while both competing proposals remain saved",
        "keeps old manager notices but creates none after demotion or release",
        "rechecks a historical pending offer even when it was closed without the command helper"
      ),
      ...t(
        I.otp,
        "limits the whole unit to 200 issued login codes",
        "resets failures on success while retaining the ten-code issuance budget",
        "allocates a pair atomically at both account and unit boundaries",
        "uses the configured quota-day boundary",
        "lets only one competing pair take the final two unit slots",
        "charges actual retry attempts atomically",
        "retains issuance budgets when a new service connection replaces the old one"
      ),
      ...t(
        I.mail,
        "sends 290 of three waves of 120, keeps the rest for the next day and never counts 360",
        "holds business mail at 290 and still sends a sign-in code from the reserve",
        "never sends an expired code, and reports one that expired waiting for quota",
        "retries with growing delays, then fails visibly while the site notice stays",
        "stops retrying when the message is no longer relevant"
      ),
      ...t(
        I.notif,
        "applies changed unit defaults to inheriting accounts without overriding a saved personal form"
      ),
      ...t(
        U.mail,
        "retries five times in total with growing delays inside 24 hours"
      ),
      ...t(I.auth, "encrypts codes and prioritizes them over reminders"),
      ...t(
        "tests/unit/secrets.test.ts",
        "authenticates purpose and record",
        "rejects short tags, noncanonical encoding",
        "rejects changed authenticated ciphertext"
      ),
      ...t(
        "tests/integration/security-conversion.test.ts",
        "converts existing mail and Calendar atomically",
        "rolls back every conversion if one old secret is corrupt"
      ),
      ...t(
        E.mail,
        "technical admin sees mail failures, the pause and the quota without personal data"
      ),
    ],
    [stagingMail]
  ),
  50: covered(
    [
      ...t(
        I.backup,
        "keeps the newest 30 and never touches files the application did not create",
        "frees the oldest copies for a new one but keeps the newest verified copy",
        "fails without deleting anything when even the older copies would not make room",
        "alerts at once when the Drive grant expired, without retrying",
        "fails at once with one alert when the encryption key is missing",
        "retries an upload failure after 15 minutes and an hour, then alerts once"
      ),
      ...t(
        I.restore,
        "restores the newest backup into a scratch database, passes every check and leaves the live system as it was"
      ),
    ],
    [driveDaily, driveRestore]
  ),
  51: covered([
    ...t(
      U.domain,
      "counts an overnight window once and applies its minimum",
      "splits actual daily time and never duplicates a fixed extra"
    ),
    ...t(
      I.comp,
      "edits a draft's roles and daily pricing, prices each seat once and leaves the catalog and other instances alone"
    ),
    ...t(U.eligibility, "checks the whole execution, not only its start"),
    ...t(
      U.rest,
      "counts it from the end of the soldier's period, not of the whole duty"
    ),
  ]),
  52: covered([
    ...t(
      I.planning,
      "recomputes candidates and the minimum after every seat of one instance"
    ),
    ...t(
      I.auth,
      "plans one seat per transaction, resumes, and leaves missing seats without moving assignments"
    ),
  ]),
  53: covered([
    ...t(
      U.domain,
      "counts an overnight window once and applies its minimum",
      "starts a surcharge window at the moment summer time skips its start time",
      "gives a surcharge window its widest meaning when winter time repeats its start time"
    ),
    ...t(
      U.weekend,
      "counts Friday and Saturday as two windows, and adds their parts before one rounding",
      "judges each day by its own hours against the minimum"
    ),
    ...t(
      U.execution,
      "tests each time extra against the performer's own overlap with its daily window"
    ),
  ]),
  54: covered([
    ...t(
      I.exec,
      "splits the daily base by actual time, credits the ended part once and keeps the rest stored",
      "requires an explicit fixed-price and bonus split, then credits each performer once",
      "adds a fixed bonus to daily time without intermediate rounding and rejects a stale split",
      "corrects credited fixed shares by the difference and keeps the seat's original total"
    ),
    ...t(
      U.execution,
      "tests each time extra against the performer's own overlap with its daily window"
    ),
  ]),
  55: covered([
    ...t(
      U.domain,
      "allows a volunteer near release without that approval alone",
      "lets a consenting volunteer bypass pending constraints but not approved ones or release"
    ),
    ...t(
      I.auth,
      "lets a volunteer near release take over automatically but never past the release boundary",
      "hands an acceptance after the start to a manager without moving the seat"
    ),
  ]),
  56: covered([
    ...t(
      I.access,
      "keeps failures on resend and refuses an unproven provider session instead of resetting them"
    ),
    ...t(
      I.google,
      "resets earlier code failures on a Google success, and a lock blocks Google and its sessions"
    ),
    ...t(
      I.auth,
      "retains failures on resend, resets on success, and consumes a code only once"
    ),
  ]),
  57: covered([
    ...t(
      I.mgrEx,
      "refuses a manual assignment with the reason, directly through the API",
      "never draws a manager, and leaves one out of the draw's picture",
      "takes no constraints from a manager and sends no round notice to one",
      "marks the soldier's reservations, keeps them in force and tells the managers",
      "clears the marks when the role is removed and opens one decision about the balance",
      "never leaves an unmarked reservation of a manager, whichever comes first"
    ),
    ...t(U.manager, "is not lifted by a specific approval"),
    ...t(
      E.manager,
      "managers are outside the ranking, the pickers and a soldier's lists, and the calendar shows what fits each"
    ),
  ]),
  58: covered([
    ...t(
      U.picker,
      "matches a name part and a personal number part as typed",
      "hides a soldier whose exemption covers only part of the range",
      "hides a soldier whose qualification expires, or starts, inside the range",
      "uses Israel days on the night the clocks go back",
      "shows a value added to a catalog with no change in code"
    ),
    ...t(
      E.picker,
      "the picker opens filtered by the duty and the role, and finds by name and personal number",
      "the server still checks a soldier the filters had hidden",
      "the picker works with the keyboard and on a phone without sideways scrolling"
    ),
  ]),
  59: covered([
    ...t(
      I.calendarLifecycle,
      "email replacement erases the old grant and pending events",
      "adopts the verified app-created calendar",
      "requires the explicit operator acknowledgement",
      "does not apply an old recovery after a new grant"
    ),
    ...t(
      I.calendarSync,
      "creates the calendar once, and one event per published seat",
      "has nothing for a soldier who never granted the permission, a duty manager, or a draft",
      "updates the event when the duty is updated and published, and removes it when the duty is cancelled",
      "moves the event with the seat when the duty is transferred by consent",
      "swaps the events of two soldiers when their duties are swapped by consent",
      "gives each performer of a seat split into execution periods the event of their own period",
      "follows the calendar slots of the reminders",
      "removes the events of a soldier who was made a duty manager",
      "stops adding and updating as soon as the switch is off",
      "removes only the future events on request",
      "refuses the switch and the button for anyone without a usable permission",
      "shows the four states of the switch",
      "never brings back an event the soldier deleted, but creates one for a new seat",
      "starts over in a new calendar when the calendar itself was deleted",
      "stops without an error",
      "treats an access error of the Calendar API like a lost permission",
      "keeps only the permission and a sealed token, never a plain one",
      "waits after a temporary failure with growing delays",
      "never asks Google sooner than it said",
      "recovers an event that Google created before the run could record it",
      "creates each event once when two runs overlap",
      "does not run while a restore keeps the system closed",
      "removes the permission, the token and the event records at once",
      "deletes a soldier even when Google cannot be reached",
      "does not make a link for an account that is already deleted"
    ),
    ...t(
      I.calendarSync,
      "pauses an uncertain calendar creation",
      "tracks uncertain event creation",
      "does not update after the switch was turned off",
      "uses the provider etag",
      "does not revoke a fresh grant",
      "retains a user-deletion tombstone"
    ),
    ...t(
      I.calendarGrant,
      "asks only for the one calendar permission and for offline access",
      "records the permission of a first sign-in with a sealed token",
      "lets a person who declines the permission sign in",
      "keeps the held token when a later sign-in",
      "turns the link to",
      "makes no link for a duty manager who signs in with Google",
      "lets the button of the settings screen ask Google to show the consent again"
    ),
    ...t(
      I.notif,
      "sends a duty reminder email only when the email slot of that reminder is marked",
      "reads a form saved with plain hours and one reminder switch"
    ),
    ...t(I.roles, "classifies every command the server knows, and no other"),
    ...t(
      U.calendarSync,
      "keeps the real instants in Israel time across midnight, several days and a clock change",
      "is blocked without a Google link",
      "holds the name, location, instructions",
      "adds a popup for every reminder marked for the calendar",
      "derives one stable id",
      "makes one event per duty, whichever rows the seat has",
      "never brings back an event the soldier deleted, and only a new seat gets a new one",
      "waits a minute after the first failure"
    ),
    ...t(
      U.notifications,
      "validates type, timing, channels and frequency on the server",
      "converts a form saved with plain hours and one reminder email switch",
      "never withholds security email and checks each business type and reminder time"
    ),
    ...t(
      E.calendarSettings,
      "a person who signed in with a code only sees the switch blocked, with the reason",
      "a person who did not grant the permission sees a button that goes to Google",
      "a person with the permission turns the sync off and on",
      "the calendar switch and the reminder slots fit a phone"
    ),
    ...t(E.prefs, "unit defaults reach soldiers without personal preferences"),
  ]),
  60: covered([
    ...t(
      I.securityErasure,
      "expires content at 30 days and never reexecutes an old key, including conflict checks",
      "prunes content at the exact 30-day boundary while retaining newer results"
    ),
    ...t(
      I.delLog,
      "never lowers the database witness when both signed copies are rolled back",
      "does not repair a torn signed entry that the database already witnessed",
      "queues a deletion in its own commit and appends it once, with ids and a time only",
      "leaves nothing in the log for a deletion that rolled back",
      "appends each deletion once and in order when workers drain at the same time",
      "is not appended to when a line was changed",
      "is released only by a person with a reason and the exact words, and the managers are told"
    ),
    ...t(
      U.deletionLog,
      "keeps only what is personal-data free: ids, a time and hashes"
    ),
  ]),
  61: covered([
    ...t(
      I.publish,
      "publishes the ready drafts together and leaves a blocked draft a draft",
      "rejects the whole action when a selected draft changed since the preview, by either manager",
      "does not publish or send twice when the same request is sent again",
      "lets only one of two managers publish the same drafts, and tells nobody twice"
    ),
    ...t(
      E.publish,
      "a manager picks a range, previews it, and publishes the ready drafts while a blocked one stays a draft"
    ),
    ...t(
      I.digest,
      "gathers publications of a window into one notice and one mail, sent when the window closes",
      "does not extend the window: an event after ten minutes opens a new window and a second mail",
      "sends a duty starting within two hours at once and apart, and keeps the rest in the window",
      "leaves out a duty published and cancelled in the same window, and sends nothing when none is left",
      "shows a read or hidden notice again, unread, when an event joins its window",
      "does not mail a switched-off type, and still writes the notice",
      "does not send a window twice when two workers claim at once"
    ),
    ...t(
      U.digest,
      "sends a duty starting within two hours at once, the boundary included",
      "follows the clock change: a night that loses an hour still reads 22:00 to 06:00"
    ),
    ...t(
      E.digest,
      "several publications reach the soldier as one notice that counts them and leads to all assignments"
    ),
    ...t(
      I.mine,
      "records batch publication and highlights every duty in the recipient's mail",
      "reads without waiting for a unit-wide writer",
      "serializes two tabs on their account",
      "does not hold another account behind a locked account",
      "records publication, advances the cursor once, and keeps later events for another window",
      "records changed duty details and removal, then clears the cancelled section on revisit",
      "highlights mail items only for their recipient and blocks technical and manager without history"
    ),
    ...t(
      U.mine,
      "uses Israel dates across midnight and distinguishes the repeated autumn hour"
    ),
    ...t(
      E.mine,
      "personal assignments on desktop and mobile, private mail highlight and visit markers"
    ),
  ]),
  62: covered([
    ...t(
      I.genders,
      "stores every gender as an empty list in the type, its roles and the duty made from it",
      "is assignable by hand, and a draw offers them, when every gender is allowed",
      "is still blocked as missing information when two of three genders are allowed",
      "is not blocked by a full list that was saved before the fix",
      "clears the gender mark only where no gender condition is left, and logs it as a system action"
    ),
    ...t(
      U.eligibility,
      "reads an empty, missing or full list as no condition",
      "does not block a soldier without a gender, in every mode"
    ),
  ]),
  63: covered(
    [
      ...t(
        "tests/integration/security-conversion.test.ts",
        "requires stopped-service acknowledgement and a recent verified backup whose stored hash still matches",
        "blocks restore when both copies contain a deletion with recomputed hashes but no valid signature",
        "refuses unsigned logs during restore",
        "refuses unequal old copies",
        "refuses a database head mismatch"
      ),
      ...t(
        "tests/unit/secrets.test.ts",
        "verifies with public keys only",
        "rejects an attacker who changes a deletion and recomputes every hash",
        "rejects unsigned old lines"
      ),
      ...t(
        I.securityErasure,
        "detects expired unpruned results and false tombstones in restore checks even without a deleted soldier"
      ),
      ...t(
        I.restore,
        "restores the newest backup into a scratch database, passes every check and leaves the live system as it was",
        "refuses a backup written by a newer version, and runs no other check on it",
        "stays closed when a check fails, and cannot be promoted",
        "refuses while anyone is connected to either database, and changes nothing",
        "reminds the technical account once when overdue, and again after 30 days"
      ),
      ...t(
        U.restore,
        "passes only when every check passed and the deletion log was applied"
      ),
      ...t(
        E.backups,
        "the restore drill row shows how long ago a backup was restored and checked end to end"
      ),
    ],
    [driveRestore]
  ),
  64: covered(
    [
      ...t(
        I.techEmail,
        "sends one code to each mailbox, stores only digests and changes nothing yet",
        "refuses the current address and an address of another account",
        "allows one request a minute and lets a new one cancel the earlier one and its mail",
        "serializes two requests made together: one succeeds, the other waits a minute",
        "needs both: one right code and one wrong code changes nothing and says nothing about which was wrong",
        "cancels the request after five mistakes, even for the right codes, and the unsent codes with it",
        "does not accept an expired request",
        "does not accept a request opened before the account's access changed",
        "moves the account: new address verified, connections and the Google link gone, recovery codes kept, and recorded with the reason",
        "signs in with a code at the new address only",
        "lets only one of two confirmations made together succeed",
        "stops when the address was given to someone else after the request",
        "is refused to a manager and a soldier, also when called directly",
        "sends a code to the new address only and needs a reason",
        "works only on the technical account, and its errors are in English",
        "moves the account with the code from the new address, ends access and replaces the recovery codes",
        "counts wrong codes and cancels after five",
        "keeps the two routes apart: a request of one is not confirmed by the other",
        "blocks the original peer takeover, including self through the soldier route",
        "rechecks the role under lock after a soldier is promoted between request and confirmation",
        "requires both mailboxes for a manager and revokes prior access on success",
        "rejects unauthorized roles before parsing and never lets a self request choose another target",
        "allows technical recovery with a reason and only the new mailbox code, and records erasable reasons",
        "rejects recovery confirmation after demotion",
        "serializes competing confirmations so only one applies"
      ),
      ...t(
        I.google,
        "drops the Google link, refuses the old Google account and links the new address afresh"
      ),
      ...t(
        E.techEmail,
        "the technical account moves itself to a new address with a code from each mailbox",
        "a manager uses its own screen and the server refuses the technical route",
        "a manager changes its own email using two codes on desktop and mobile",
        "the technical account recovers a manager email using a reason and the new code"
      ),
    ],
    [stagingTechnicalAddress]
  ),
};

export type RoleKey = "soldier" | "manager" | "otherManager" | "technical";
export type RoleState =
  "allowed" | "forbidden" | "empty" | "loading" | "error" | "changed";
export const roleKeys: RoleKey[] = [
  "soldier",
  "manager",
  "otherManager",
  "technical",
];
export const roleStates: RoleState[] = [
  "allowed",
  "forbidden",
  "empty",
  "loading",
  "error",
  "changed",
];
const everyone = (...groups: Evidence[][]) =>
  Object.fromEntries(roleKeys.map((role) => [role, groups.flat()])) as Record<
    RoleKey,
    Evidence[]
  >;
const sweepAll = t(E.sweep, "is Hebrew, named and fits a phone");

/** Each role in each state, for acceptance criterion 2 of card #38. */
export const roleMatrix: Record<RoleState, Record<RoleKey, Evidence[]>> = {
  allowed: everyone(
    t(
      I.roles,
      "lets each role reach the commands it is for, and never fails with a server error"
    ),
    sweepAll
  ),
  forbidden: everyone(
    t(
      I.roles,
      "refuses a role that the command is not for with 403, before reading the payload"
    ),
    t(E.sweep, "and sees nothing of it")
  ),
  empty: everyone(
    t(I.roles, "shows an empty unit to everyone without an error"),
    sweepAll
  ),
  loading: everyone(t(E.sweep, "a loading screen, then the content")),
  error: everyone(
    t(
      E.sweep,
      "when the state cannot load, and recovers on retry",
      "to the sign-in page when the session ended"
    ),
    t(
      I.roles,
      "sends a malformed envelope back as a validation error, not a failure",
      "asks for a fresh sign-in on every command when the account changed, before any role check"
    )
  ),
  changed: {
    soldier: [
      ...t(
        I.roles,
        "makes a soldier read the form again after the preferences changed"
      ),
      ...t(
        E.sweep,
        "in a second tab that the form changed, and shows what was saved"
      ),
    ],
    manager: [
      ...t(
        I.roles,
        "makes the second of two managers read again before saving a soldier",
        "makes a manager read the duty again after another manager changed it"
      ),
      ...t(
        E.sweep,
        "in a second tab that the form changed, and shows what was saved"
      ),
    ],
    otherManager: [
      ...t(
        I.roles,
        "makes the second of two managers read again before saving a soldier",
        "makes a manager read the duty again after another manager changed it"
      ),
      ...t(
        E.sweep,
        "in a second tab that the form changed, and shows what was saved"
      ),
    ],
    technical: [
      ...t(
        I.roles,
        "makes the technical account read the account again before changing a role"
      ),
      ...t(
        E.sweep,
        "in a second tab that the form changed, and shows what was saved"
      ),
    ],
  },
};

export type Aspect =
  | "privacy"
  | "concurrency"
  | "hebrew"
  | "mobile"
  | "keyboard"
  | "monthEnd"
  | "clockChange";
export const aspects: Record<Aspect, Evidence[]> = {
  privacy: [
    ...t(
      I.roles,
      "keeps contact details out of every state but a manager's",
      "keeps another soldier's exemptions and hours out of a soldier's state"
    ),
    ...t(
      I.audit,
      "keeps personal text out of the envelope, and keeps the envelope when that text is erased"
    ),
    ...t(
      I.cancel,
      "submitting changes neither the seat, the calendar nor reserved points, and is visible only to its owner and managers"
    ),
    ...t(I.soldierDel, "is removed, while the event and the history stay"),
  ],
  concurrency: [
    ...t(I.auth, "lets only one of two managers occupy the last place"),
    ...t(
      I.planning,
      "lets two managers plan overlapping duties at once without booking one soldier twice"
    ),
    ...t(
      I.swaps,
      "swaps both seats together with their full value, without a score check, and completes once when two acceptances race"
    ),
    ...t(I.soldierDel, "lets only one of two simultaneous deletions win"),
    ...t(
      I.delExec,
      "never credits twice when the worker and the manager's decision race"
    ),
    ...t(
      I.mgrEx,
      "holds with two managers assigning one soldier to different duties meanwhile"
    ),
    ...t(
      I.backup,
      "accepts one waiting request at a time and two workers back up once"
    ),
  ],
  hebrew: [
    ...sweepAll,
    ...t(
      E.picker,
      "the picker works with the keyboard and on a phone without sideways scrolling"
    ),
  ],
  mobile: [
    ...sweepAll,
    ...t(
      E.picker,
      "the picker works with the keyboard and on a phone without sideways scrolling"
    ),
    ...t(
      E.cards,
      "soldier summary cards filter, restore and focus the score at width"
    ),
    ...t(
      E.soldierDel,
      "the deletion screen fits a phone and a manager cannot delete their own record"
    ),
  ],
  keyboard: [
    ...t(E.sweep, "without a mouse"),
    ...t(
      E.picker,
      "the picker works with the keyboard and on a phone without sideways scrolling"
    ),
    ...t(
      E.cards,
      "soldier summary cards filter, restore and focus the score at width"
    ),
  ],
  monthEnd: [
    ...t(
      U.calendar,
      "builds a Sunday-first month grid and moves across years",
      "keeps a duty ending exactly at midnight within its own day and month"
    ),
    ...t(
      U.calFilters,
      "uses Israeli month boundaries for cards as well as the calendar"
    ),
    ...t(
      U.service,
      "ends on the last day of a shorter month, which is itself available",
      "starts the month before release on the same calendar day, or the last day of a shorter month"
    ),
    ...t(U.domain, "uses a calendar month for grace at month end"),
  ],
  clockChange: [
    ...t(
      U.domain,
      "starts a surcharge window at the moment summer time skips its start time",
      "prices a daytime duty on a clock-change date outside the changed hour"
    ),
    ...t(
      U.execution,
      "measures real hours across the end of summer time in Israel"
    ),
    ...t(U.rest, "still rests at 03:30 summer time"),
    ...t(
      U.calendar,
      "uses local days across DST changes while the duration stays actual time"
    ),
    ...t(I.rounds, "schedules by the Israeli calendar when winter time starts"),
    ...t(
      I.auth,
      "rejects submissions outside the window or target period and applies whole Israel days across a clock change"
    ),
    ...t(U.backup, "keeps one key on the nights the clock changes"),
  ],
};

export type Recovery =
  | "workerDown"
  | "retries"
  | "importRestore"
  | "backupRestore"
  | "randomness"
  | "clock";
export const recovery: Record<Recovery, Evidence[]> = {
  workerDown: [
    ...t(
      I.reminders,
      "merges times missed while the worker was down into one reminder and skips a duty that started"
    ),
    ...t(
      I.rounds,
      "skips stale notices after downtime and merges an overdue opening"
    ),
    ...t(
      I.service,
      "announces a departure once to each manager across repeated runs, races and downtime, without deleting"
    ),
    ...t(
      I.auth,
      "reports a missing worker without failing the site",
      "tracks beats, keeps the last success while paused and marks delays"
    ),
  ],
  retries: [
    ...t(
      I.mail,
      "retries with growing delays, then fails visibly while the site notice stays",
      "stops retrying when the message is no longer relevant"
    ),
    ...t(
      I.backup,
      "retries an upload failure after 15 minutes and an hour, then alerts once"
    ),
    ...t(
      U.mail,
      "retries five times in total with growing delays inside 24 hours"
    ),
    ...t(
      I.signal,
      "reconnects after losing its connection and sends a code committed meanwhile"
    ),
  ],
  importRestore: [
    ...t(
      I.auth,
      "restores unchanged imported fields while preserving later edits and reservations",
      "cancels a new soldier without activity: removes every trace, frees the number and keeps the row"
    ),
    ...t(
      E.importPop,
      "a restore that moves the population shows its assignments per the chosen decision and flags them after confirmation"
    ),
    ...t(
      E.importCreate,
      "cancels a new soldier without activity and waits for a decision on one who signed in"
    ),
  ],
  backupRestore: [
    ...t(
      I.restore,
      "restores the newest backup into a scratch database, passes every check and leaves the live system as it was",
      "are applied again from the log before anything of the restored copy is open, and no deleted data returns"
    ),
    ...t(
      I.backup,
      "produces a verified copy that is only ciphertext, decrypts and restores the data"
    ),
  ],
  randomness: [
    ...t(
      U.lottery,
      "gives every member of the band an equal share of the random range",
      "rejects a source that leaves the range from 0 up to, not including, 1"
    ),
    ...t(U.domain, "filters before minimum and uses a strict upper bound"),
  ],
  clock: [
    ...t(
      I.service,
      "applies the boundary at 00:00 Israel time with an explicit clock"
    ),
    ...t(
      I.backup,
      "runs once per Israel date from 03:30 and not while restore mode is on"
    ),
    ...t(U.rest, "is free from 04:00 summer time"),
    ...t(
      U.restore,
      "is ok after a passed drill and overdue after more than 100 days"
    ),
  ],
};

/** What nothing automated shows, and whom it waits for. */
export const external: External[] = [
  stagingGoogle,
  stagingMail,
  driveDaily,
  {
    what: "תקלה וחזרה של פריסה אוטומטית בשרת",
    state: "verified",
    ref: "#36",
  },
  driveRestore,
  {
    what: "גיבוי לפני מיגרציה כשמיגרציה משנה את המסד, בשרת",
    state: "pending",
    ref: "#36",
  },
  {
    what: "תורנויות ביומן Google של חייל אמיתי",
    state: "pending",
    ref: "#92",
  },
  pilot,
  {
    what: "קורא מסך אמיתי (הבדיקות האוטומטיות אינן אישור נגישות)",
    state: "pending",
  },
];
