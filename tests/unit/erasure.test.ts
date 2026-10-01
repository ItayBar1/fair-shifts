import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ERASED_NOTE,
  ERASED_REASON,
  hasConditions,
  needlesOf,
  notificationIsFor,
  recordPolicies,
  scrubApprovals,
  scrubAssignmentApproval,
  scrubConstraint,
  scrubImportRow,
  scrubLotteryAttempt,
  scrubLotteryExclusion,
  scrubNotification,
  scrubRequest,
  withoutConditions,
} from "../../src/domain/erasure";
import { soldier } from "../fixtures";

const AT = "2026-10-01T10:00:00.000Z";
const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

/** Every record kind the server writes, found in its source. */
function writtenKinds() {
  const root = join(__dirname, "../../src");
  const kinds = new Set<string>();
  for (const name of readdirSync(root, { recursive: true }) as string[]) {
    if (!name.endsWith(".ts") || !name.startsWith("server")) continue;
    const source = readFileSync(join(root, name), "utf8");
    for (const match of source.matchAll(/createRecord\(\s*\w+,\s*"([a-z_]+)"/g))
      kinds.add(match[1]);
    for (const match of source.matchAll(
      /insert\(records\)\s*\.values\(\{[^}]*?kind:\s*"([a-z_]+)"/g
    ))
      kinds.add(match[1]);
  }
  return kinds;
}

describe("registry of record kinds (decision 192)", () => {
  it("classifies every kind the server writes", () => {
    const missing = [...writtenKinds()].filter((kind) => !recordPolicies[kind]);
    expect(missing).toEqual([]);
  });
  it("has no entry for a kind nobody writes", () => {
    const written = writtenKinds();
    const stale = Object.keys(recordPolicies).filter(
      (kind) => !written.has(kind)
    );
    expect(stale).toEqual([]);
  });
  it("explains each policy", () => {
    for (const [kind, policy] of Object.entries(recordPolicies))
      expect(policy.why.length, kind).toBeGreaterThan(5);
  });
});

describe("profile conditions", () => {
  const rich = soldier({
    exemptions: [{ exemptionId: "e", start: "2026-01-01", end: "2026-12-31" }],
    qualifications: [
      { qualificationId: "q", start: "2026-01-01", end: "2026-12-31" },
    ],
    inactivePeriods: [{ start: "2026-02-01", end: "2026-02-03" }],
    gender: "female",
    capabilities: ["driver"],
    allowedHours: [
      {
        id: "h",
        start: "2026-01-01",
        end: "2026-12-31",
        windows: [{ startTime: "08:00", endTime: "16:00" }],
      },
    ],
  });
  it("removes the conditions and keeps the rest of the profile", () => {
    const next = withoutConditions({
      ...rich,
      rankHistory: [
        { effectiveFrom: "2026-01-01", rankId: "r", trackId: "t", order: 1 },
      ],
    });
    expect(hasConditions(rich)).toBe(true);
    expect(hasConditions(next)).toBe(false);
    expect("gender" in next).toBe(false);
    expect(next.name).toBe(rich.name);
    expect(next.personalNumber).toBe(rich.personalNumber);
    expect(next.service).toEqual(rich.service);
    expect(next.rankHistory).toHaveLength(1);
  });
  it("does not change the profile it was given", () => {
    withoutConditions(rich);
    expect(rich.exemptions).toHaveLength(1);
    expect(rich.gender).toBe("female");
  });
});

describe("approvals", () => {
  const approvals = [
    { soldierId: ME, reason: "פטור רפואי" },
    { soldierId: OTHER, reason: "נימוק של אחר" },
  ];
  it("replaces only the soldier's reasons when asked for one soldier", () => {
    const next = scrubApprovals(approvals, ME) as typeof approvals;
    expect(next[0].reason).toBe(ERASED_REASON);
    expect(next[1].reason).toBe("נימוק של אחר");
  });
  it("is a no-op the second time", () => {
    const once = scrubApprovals(approvals, ME);
    expect(scrubApprovals(once, ME)).toBeUndefined();
  });
  it("keeps an approval valid: the reason stays non-empty", () => {
    const next = scrubAssignmentApproval({ approvals }) as {
      approvals: { reason: string }[];
    };
    expect(next.approvals.every((item) => item.reason.trim() !== "")).toBe(
      true
    );
  });
});

describe("constraints", () => {
  const record = {
    roundId: "r",
    status: "approved",
    pending: {
      version: 2,
      start: "2026-11-10",
      end: "2026-11-11",
      reason: "א",
    },
    approved: {
      version: 1,
      start: "2026-11-01",
      end: "2026-11-02",
      reason: "ב",
    },
    rejected: null,
    declared: null,
    decisionReason: "ג",
  };
  it("keeps the dates and drops every reason", () => {
    const next = scrubConstraint(record, AT) as typeof record & {
      erasedAt: string;
    };
    expect(next.pending).toEqual({
      version: 2,
      start: "2026-11-10",
      end: "2026-11-11",
    });
    expect(next.approved).toEqual({
      version: 1,
      start: "2026-11-01",
      end: "2026-11-02",
    });
    expect("decisionReason" in next).toBe(false);
    expect(next.erasedAt).toBe(AT);
    expect(JSON.stringify(next)).not.toMatch(/[אבג]"/);
  });
  it("leaves a record without reasons alone", () => {
    expect(
      scrubConstraint({ status: "declared", declared: { none: true } }, AT)
    ).toBeUndefined();
  });
});

describe("requests", () => {
  const cancellation = {
    type: "cancellation",
    soldierId: ME,
    status: "rejected",
    reason: "אירוע משפחתי",
    decision: { outcome: "rejected", reason: "לא מאושר", deciderName: "אחראי" },
    closedReason: "נסגר: לא מאושר",
  };
  it("removes an owner's reasons and keeps the outcome", () => {
    const next = scrubRequest(cancellation, ME, true, AT)!;
    expect(next.reason).toBeUndefined();
    expect(next.status).toBe("rejected");
    expect((next.decision as { reason: string }).reason).toBe(ERASED_REASON);
    expect(next.closedReason).toBe(ERASED_NOTE);
    expect(next.erasedAt).toBe(AT);
  });
  it("ignores a request of someone else", () => {
    expect(scrubRequest(cancellation, OTHER, false, AT)).toBeUndefined();
  });
  it("keeps the owner's own reason when only a candidate is deleted", () => {
    const transfer = {
      type: "transfer",
      fromSoldierId: OTHER,
      reason: "הסיבה של הבעלים",
      candidates: [{ soldierId: ME, status: "accepted" }],
      acceptedBy: ME,
      decisionReason: "אין התאמה לפטור",
      managerReasons: [{ code: "exemption", message: "נדרש אישור לפטור" }],
      approvals: [
        { soldierId: ME, reason: "אושר בגלל מצב רפואי" },
        { soldierId: OTHER, reason: "אחר" },
      ],
    };
    const next = scrubRequest(transfer, ME, false, AT)!;
    expect(next.reason).toBe("הסיבה של הבעלים");
    expect(next.decisionReason).toBe(ERASED_NOTE);
    expect(next.managerReasons).toEqual([]);
    const approvals = next.approvals as { reason: string }[];
    expect(approvals[0].reason).toBe(ERASED_REASON);
    expect(approvals[1].reason).toBe("אחר");
  });
  it("removes only the deleted side's reasons in a swap", () => {
    const swap = {
      type: "swap",
      fromSoldierId: OTHER,
      candidates: [
        { soldierId: ME, status: "closed", closedReason: "סיבה אישית" },
      ],
      managerReasons: [
        { soldierId: ME, code: "exemption", message: "פטור" },
        { soldierId: OTHER, code: "rank", message: "דרגה" },
      ],
    };
    const next = scrubRequest(swap, ME, false, AT)!;
    expect(next.managerReasons).toEqual([
      { soldierId: OTHER, code: "rank", message: "דרגה" },
    ]);
    expect(
      (next.candidates as { closedReason: string }[])[0].closedReason
    ).toBe(ERASED_NOTE);
  });
  it("is a no-op the second time", () => {
    const once = scrubRequest(cancellation, ME, true, AT)!;
    expect(scrubRequest(once, ME, true, AT)).toBeUndefined();
  });
});

describe("lottery pictures", () => {
  const attempt = {
    status: "approval_required",
    candidateId: ME,
    reason: "אושר למרות פטור",
    requirements: [{ code: "exemption", message: "נדרש אישור חריג לפטור" }],
    candidates: [
      {
        id: ME,
        score: 40,
        status: "approval_required",
        blockers: [],
        approvalsRequired: [{ code: "exemption", message: "פטור" }],
      },
      {
        id: OTHER,
        score: 50,
        status: "blocked",
        blockers: [{ code: "inactive", message: "אי־פעילות" }],
        approvalsRequired: [],
      },
    ],
  };
  it("keeps score and status, drops the soldier's reasons", () => {
    const next = scrubLotteryAttempt(attempt, ME)! as typeof attempt;
    expect(next.candidates[0]).toEqual({
      id: ME,
      score: 40,
      status: "approval_required",
      blockers: [],
      approvalsRequired: [],
    });
    expect(next.requirements).toEqual([]);
    expect("reason" in next).toBe(false);
  });
  it("does not touch another candidate's picture", () => {
    const next = scrubLotteryAttempt(attempt, ME)! as typeof attempt;
    expect(next.candidates[1]).toEqual(attempt.candidates[1]);
  });
  it("stales a proposal that waited for the deleted soldier", () => {
    expect(scrubLotteryAttempt(attempt, ME)!.status).toBe("stale");
  });
  it("leaves an unrelated draw alone", () => {
    expect(
      scrubLotteryAttempt(
        { ...attempt, candidates: [], candidateId: OTHER },
        ME
      )
    ).toBeUndefined();
  });
  it("drops a rejection's reason", () => {
    expect(scrubLotteryExclusion({ dutyId: "d", reason: "ר" })).toEqual({
      dutyId: "d",
    });
    expect(scrubLotteryExclusion({ dutyId: "d" })).toBeUndefined();
  });
});

describe("import rows", () => {
  const row = {
    batchId: "b",
    rowNumber: 3,
    mode: "update",
    name: "חייל",
    values: { personalNumber: "123", phone: "0500000000", email: "a@b.c" },
    profile: { phone: "0500000000", address: "רחוב" },
    changes: [{ key: "phone", before: "1", after: "2", source: "contact" }],
    newRowRestored: { action: "kept", reason: "ר", actorId: "x", at: AT },
  };
  it("keeps the row number, name, number and outcome only", () => {
    const next = scrubImportRow(row)!;
    expect(next).toEqual({
      batchId: "b",
      rowNumber: 3,
      mode: "update",
      name: "חייל",
      erased: true,
      values: { personalNumber: "123" },
      changes: [],
      newRowRestored: { action: "kept" },
    });
    expect(JSON.stringify(next)).not.toMatch(/0500000000|a@b\.c|רחוב/);
  });
  it("is a no-op the second time", () => {
    expect(scrubImportRow(scrubImportRow(row)!)).toBeUndefined();
  });
});

describe("notifications", () => {
  it("belongs to the soldier by subject or account", () => {
    expect(notificationIsFor({}, ME, ME, undefined)).toBe(true);
    expect(notificationIsFor({ accountId: "a" }, null, ME, "a")).toBe(true);
    expect(notificationIsFor({ accountId: "b" }, null, ME, "a")).toBe(false);
    expect(notificationIsFor({}, OTHER, ME, "a")).toBe(false);
  });
  it("loses the quoted reason of a request that concerned the soldier", () => {
    const notice = { requestId: "r1", title: "נדחתה", body: "נדחתה: סיבה" };
    const next = scrubNotification(notice, new Set(["r1"]), AT)!;
    expect(next.body).toBe(ERASED_NOTE);
    expect(next.title).toBe("נדחתה");
    expect(scrubNotification(notice, new Set(["r2"]), AT)).toBeUndefined();
    expect(scrubNotification(next, new Set(["r1"]), AT)).toBeUndefined();
  });
});

describe("stored command results", () => {
  it("looks for the id and the contact values as stored in JSON", () => {
    const needles = needlesOf(ME, {
      email: "a@example.invalid",
      phone: " 0500000000 ",
      address: 'רחוב "הדגמה" 5',
    });
    expect(needles).toContain(ME);
    expect(needles).toContain("a@example.invalid");
    expect(needles).toContain("0500000000");
    // A quote is stored escaped inside JSON text.
    expect(needles).toContain('רחוב \\"הדגמה\\" 5');
    expect(JSON.stringify({ x: 'רחוב "הדגמה" 5' })).toContain(needles[3]);
  });
  it("skips empty contact values", () => {
    expect(needlesOf(ME, { email: null, phone: "  ", address: "" })).toEqual([
      ME,
    ]);
  });
});
