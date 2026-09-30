import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The rulesets are imported into the repository settings by hand (decision 184).
// These checks keep the files in line with the CI workflow and the agreed policy.
type Rule = { type: string; parameters?: Record<string, unknown> };
type Ruleset = {
  conditions: { ref_name: { include: string[] } };
  bypass_actors: {
    actor_type: string;
    actor_id: number;
    bypass_mode: string;
  }[];
  rules: Rule[];
};
const ruleset = (name: string) =>
  JSON.parse(readFileSync(`.github/rulesets/${name}.json`, "utf8")) as Ruleset;
const rule = (set: Ruleset, type: string) =>
  set.rules.find((candidate) => candidate.type === type);
const baseline = ruleset("main-baseline");
const review = ruleset("main-review");

describe("main branch rules", () => {
  it("requires the CI job that the workflow actually runs, on an up-to-date branch", () => {
    const checks = rule(baseline, "required_status_checks")!.parameters!;
    expect(checks.strict_required_status_checks_policy).toBe(true);
    const contexts = (
      checks.required_status_checks as { context: string }[]
    ).map((check) => check.context);
    const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
    const jobs = workflow.slice(workflow.indexOf("\njobs:"));
    for (const context of contexts)
      expect(jobs).toMatch(new RegExp(`\\n  ${context}:\\n`));
    expect(workflow).toMatch(/\n {2}pull_request:/);
  });
  it("blocks force push and deletion and requires a PR for everyone", () => {
    expect(baseline.bypass_actors).toEqual([]);
    expect(rule(baseline, "deletion")).toBeDefined();
    expect(rule(baseline, "non_fast_forward")).toBeDefined();
    expect(rule(baseline, "pull_request")).toBeDefined();
  });
  it("lets only an admin skip the second developer's approval, through a PR", () => {
    expect(rule(review, "pull_request")!.parameters).toMatchObject({
      required_approving_review_count: 1,
    });
    expect(review.bypass_actors).toEqual([
      {
        actor_type: "RepositoryRole",
        actor_id: 5,
        bypass_mode: "pull_request",
      },
    ]);
    expect(review.rules.map((candidate) => candidate.type)).toEqual([
      "pull_request",
    ]);
  });
  it("applies both rulesets to the default branch", () => {
    for (const set of [baseline, review])
      expect(set.conditions.ref_name.include).toEqual(["~DEFAULT_BRANCH"]);
  });
});
