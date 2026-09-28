import {
  coveredByRanges,
  dailyWindows,
  datesToInstants,
  graceEnd,
  instant,
  interval,
  localDate,
  overlaps,
  releaseBoundary,
} from "./time";
import type {
  Duty,
  DutySlot,
  EffectiveRank,
  EligibilityContext,
  EligibilityReason,
  EligibilityResult,
  Population,
  RankClause,
  Requirements,
  Soldier,
  SpecificApproval,
} from "./types";

export function populationAt(soldier: Soldier, at: string): Population {
  const date = instant(at).toISODate()!;
  const history = [...soldier.populationHistory];
  if (soldier.service.permanentFrom)
    history.push({
      effectiveFrom: soldier.service.permanentFrom,
      population: "career",
    });
  if (soldier.service.officerFrom)
    history.push({
      effectiveFrom: soldier.service.officerFrom,
      population: "career",
    });
  return (
    history
      .filter((entry) => entry.effectiveFrom <= date)
      .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0]
      ?.population ?? soldier.service.basePopulation
  );
}

export function rankAt(
  soldier: Soldier,
  at: string
): EffectiveRank | undefined {
  const date = instant(at).toISODate()!;
  return [...soldier.rankHistory]
    .filter((rank) => rank.effectiveFrom <= date)
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
}

export function matchesRank(
  rank: EffectiveRank,
  clauses: RankClause[]
): boolean {
  return clauses.some(
    (clause) =>
      clause.trackId === rank.trackId &&
      (!clause.rankIds || clause.rankIds.includes(rank.rankId)) &&
      (clause.minOrder === undefined || rank.order >= clause.minOrder) &&
      (clause.maxOrder === undefined || rank.order <= clause.maxOrder)
  );
}

export function canAccessAfterService(soldier: Soldier, now: string): boolean {
  return (
    !soldier.deletedAt &&
    (!soldier.service.releaseDate ||
      instant(now) < instant(releaseBoundary(soldier.service.releaseDate)))
  );
}

export function isNearRelease(soldier: Soldier, duty: Duty): boolean {
  if (!soldier.service.releaseDate) return false;
  const start = instant(duty.start);
  return (
    start >= localDate(soldier.service.releaseDate).minus({ months: 1 }) &&
    start < instant(releaseBoundary(soldier.service.releaseDate))
  );
}

function populationFits(
  soldier: Soldier,
  duty: Duty,
  populations: Population[]
): boolean {
  const target = interval(duty);
  const dates = [
    ...soldier.populationHistory.map((entry) => entry.effectiveFrom),
    soldier.service.permanentFrom,
    soldier.service.officerFrom,
  ].filter((date): date is string => Boolean(date));
  const checkpoints = [
    duty.start,
    ...dates
      .map((date) => localDate(date).toISO()!)
      .filter((date) => {
        const value = instant(date).toMillis();
        return value > target.start && value < target.end;
      }),
  ];
  return checkpoints.every((at) =>
    populations.includes(populationAt(soldier, at))
  );
}

export function evaluateEligibility(
  soldier: Soldier,
  duty: Duty,
  slot: DutySlot,
  context: EligibilityContext
): EligibilityResult {
  const blockers: EligibilityReason[] = [];
  const approvalsRequired: EligibilityReason[] = [];
  const target = interval(duty);
  const hasApproval = (
    kind: SpecificApproval["kind"],
    referenceId?: string,
    referenceVersion?: number
  ): boolean =>
    Boolean(
      context.approvals?.some(
        (approval) =>
          approval.kind === kind &&
          approval.soldierId === soldier.id &&
          approval.dutyId === duty.id &&
          approval.dutyVersion === (duty.rulesVersion ?? duty.version) &&
          (approval.soldierVersion === undefined ||
            approval.soldierVersion === soldier.version) &&
          approval.referenceId === referenceId &&
          approval.referenceVersion === referenceVersion &&
          approval.reason.trim() &&
          approval.approvedBy &&
          approval.approvedAt
      )
    );
  const block = (code: string, message: string, referenceId?: string): void => {
    blockers.push({ code, message, ...(referenceId ? { referenceId } : {}) });
  };
  const requireApproval = (
    code: string,
    message: string,
    referenceId?: string,
    referenceVersion?: number
  ): void => {
    approvalsRequired.push({
      code,
      message,
      ...(referenceId ? { referenceId } : {}),
      ...(referenceVersion === undefined ? {} : { referenceVersion }),
    });
  };

  if (soldier.deletedAt) block("deleted", "החשבון נמחק");
  if (duty.status === "cancelled") block("cancelled", "התורנות בוטלה");
  if (!duty.slots.some((candidate) => candidate.id === slot.id))
    block("unknown_slot", "המקום אינו שייך לתורנות");
  if (
    soldier.service.arrivalDate &&
    target.start < localDate(soldier.service.arrivalDate).toMillis()
  )
    block("before_arrival", "התורנות מתחילה לפני ההגעה ליחידה");
  if (soldier.service.graceEligible) {
    if (!soldier.service.arrivalDate)
      block("missing_arrival", "מידע חסר: תאריך הגעה לחישוב חסד");
    else if (
      target.start < localDate(graceEnd(soldier.service.arrivalDate)).toMillis()
    )
      block("grace", "החייל בתקופת חסד");
  }
  if (
    soldier.service.releaseDate &&
    target.end >
      instant(releaseBoundary(soldier.service.releaseDate)).toMillis()
  )
    block("released", "התורנות חורגת מסוף יום השחרור");
  if (
    soldier.inactivePeriods.some((period) =>
      overlaps(target, datesToInstants(period))
    )
  )
    block("inactive", "התורנות חופפת לתקופת אי־פעילות");

  const checkRequirements = (
    requirements: Requirements,
    reference: string
  ): void => {
    if (
      requirements.populations &&
      !populationFits(soldier, duty, requirements.populations)
    )
      block(
        "population",
        "אוכלוסיית השירות אינה מתאימה לכל התורנות",
        reference
      );
    if (
      requirements.genders?.length &&
      (!soldier.gender || !requirements.genders.includes(soldier.gender))
    )
      block("gender", "תנאי המגדר אינו מתקיים", reference);
    for (const capability of requirements.capabilityIds ?? []) {
      if (!soldier.capabilities?.includes(capability))
        block("capability", "מידע חסר או יכולת נדרשת אינה מתקיימת", capability);
    }
    for (const qualificationId of requirements.qualificationIds ?? []) {
      const ranges = soldier.qualifications
        .filter(
          (qualification) => qualification.qualificationId === qualificationId
        )
        .map(datesToInstants);
      if (!coveredByRanges(target, ranges))
        block(
          "qualification",
          "כשירות נדרשת אינה תקפה לכל הביצוע",
          qualificationId
        );
    }
    for (const exemptionId of requirements.blockingExemptionIds ?? []) {
      if (
        !soldier.exemptions.some(
          (exemption) =>
            exemption.exemptionId === exemptionId &&
            overlaps(target, datesToInstants(exemption))
        )
      )
        continue;
      if (context.mode !== "automatic") {
        if (!hasApproval("exemption", exemptionId))
          requireApproval(
            "exemption",
            "נדרש אישור חריג לפטור עם סיבה",
            exemptionId
          );
      } else
        block(
          "exemption",
          "פטור רלוונטי חוסם; חריגה אפשרית בשיבוץ ידני בלבד",
          exemptionId
        );
    }
    if (requirements.ranks?.length) {
      const rank = rankAt(soldier, duty.start);
      if (!rank || !matchesRank(rank, requirements.ranks)) {
        if (context.mode !== "automatic") {
          if (!hasApproval("rank", reference))
            requireApproval(
              "rank",
              rank ? "נדרש אישור חריג דרגה" : "מידע חסר: דרגה; נדרש אישור חריג",
              reference
            );
        } else
          block(
            "rank",
            rank ? "הדרגה בתחילת התורנות אינה מתאימה" : "מידע חסר: דרגה נדרשת",
            reference
          );
      }
    }
  };
  checkRequirements(duty.requirements, "duty");
  if (slot.requirements)
    checkRequirements(slot.requirements, `slot:${slot.id}`);

  if (
    soldier.allowedHours &&
    !coveredByRanges(
      target,
      soldier.allowedHours.flatMap((window) => dailyWindows(duty, window))
    )
  )
    block("allowed_hours", "התורנות חורגת מטווח השעות המותר");
  // A consenting volunteer's own pending constraints never route a transfer to a manager (decision 161).
  const volunteer = context.mode === "volunteer";
  const pending = soldier.constraints.filter(
    (constraint) => constraint.status === "pending"
  );
  if (pending.length && !context.pendingReviewConfirmed && !volunteer)
    requireApproval("pending_review", "יש לאשר המשך לפני סיום סקירת האילוצים");
  for (const constraint of soldier.constraints) {
    if (
      constraint.status === "rejected" ||
      (constraint.status === "pending" && volunteer) ||
      !overlaps(target, datesToInstants(constraint))
    )
      continue;
    if (constraint.status === "approved")
      block("approved_constraint", "אילוץ מאושר חוסם את השיבוץ", constraint.id);
    else if (
      !hasApproval("pending_constraint", constraint.id, constraint.version)
    )
      requireApproval(
        "pending_constraint",
        "נדרש אישור פרטני להתנגשות עם אילוץ ממתין",
        constraint.id,
        constraint.version
      );
  }
  const ignored = new Set(context.ignoreAssignmentIds ?? []);
  const active = context.assignments.filter(
    (assignment) =>
      assignment.soldierId === soldier.id &&
      assignment.status !== "cancelled" &&
      !ignored.has(assignment.id)
  );
  for (const assignment of active) {
    if (assignment.dutyId === duty.id) {
      block("already_assigned", "החייל כבר משובץ במופע זה", assignment.id);
      continue;
    }
    const other = context.duties.find(
      (candidate) => candidate.id === assignment.dutyId
    );
    if (!other) {
      block("missing_duty", "מידע חסר: תורנות קיימת", assignment.id);
      continue;
    }
    if (other.status === "cancelled") continue;
    const otherRange = interval(other);
    const targetRest = {
      start: target.start - duty.restBeforeMinutes * 60_000,
      end: target.end + duty.restAfterMinutes * 60_000,
    };
    const otherRest = {
      start: otherRange.start - other.restBeforeMinutes * 60_000,
      end: otherRange.end + other.restAfterMinutes * 60_000,
    };
    if (overlaps(target, otherRest) || overlaps(otherRange, targetRest))
      block("overlap_or_rest", "התנגשות בביצוע או בחלון מנוחה", assignment.id);
  }
  if (
    context.mode !== "volunteer" &&
    isNearRelease(soldier, duty) &&
    !hasApproval("near_release")
  )
    requireApproval("near_release", "נדרש אישור בחירה בחודש שלפני השחרור");
  return {
    status: blockers.length
      ? "blocked"
      : approvalsRequired.length
        ? "approval_required"
        : "eligible",
    blockers,
    approvalsRequired,
  };
}
