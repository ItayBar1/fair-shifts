import { z } from "zod";

export function verifyEffectiveMainRules(input: unknown, details: unknown[]) {
  const rules = z
    .array(
      z
        .object({
          type: z.string(),
          ruleset_id: z.number().int().positive(),
          parameters: z.record(z.string(), z.unknown()).optional(),
        })
        .passthrough()
    )
    .parse(input);
  const sets = z
    .array(
      z
        .object({
          id: z.number(),
          enforcement: z.literal("active"),
          bypass_actors: z.array(z.unknown()).length(0),
        })
        .passthrough()
    )
    .parse(details);
  if (rules.some((rule) => !sets.some((set) => set.id === rule.ruleset_id)))
    throw new Error("An effective ruleset was not verified");
  for (const type of ["deletion", "non_fast_forward"])
    if (!rules.some((rule) => rule.type === type))
      throw new Error("Main permits deletion or force push");
  const reviews = rules.filter((rule) => rule.type === "pull_request");
  if (
    !reviews.some(
      (rule) => Number(rule.parameters?.required_approving_review_count) >= 1
    ) ||
    reviews.some(
      (rule) =>
        rule.parameters?.dismiss_stale_reviews_on_push !== true ||
        rule.parameters?.require_last_push_approval !== true
    )
  )
    throw new Error("Main review does not cover the latest changes");
  if (
    !rules.some(
      (rule) =>
        rule.type === "required_status_checks" &&
        rule.parameters?.strict_required_status_checks_policy === true &&
        Array.isArray(rule.parameters.required_status_checks) &&
        rule.parameters.required_status_checks.some(
          (check) =>
            check.context === "verify" && check.integration_id === 15368
        )
    )
  )
    throw new Error("Main does not require the up-to-date GitHub verify job");
  return {
    rulesets: sets.map((set) => set.id),
    requiredCheck: "verify",
    bypass: false,
    staleReviewsDismissed: true,
    latestPushApproval: true,
  };
}
