import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { verifyEffectiveMainRules } from "../../src/domain/repository-rules";

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
  it("verifies effective GitHub rules and fails closed if a matching ruleset permits bypass", () => {
    const effective = [baseline, review].flatMap((set, index) =>
      set.rules.map((value) => ({ ...value, ruleset_id: index + 1 }))
    );
    const details = [baseline, review].map((set, index) => ({
      ...set,
      id: index + 1,
      enforcement: "active",
    }));
    expect(verifyEffectiveMainRules(effective, details)).toMatchObject({
      bypass: false,
      latestPushApproval: true,
      staleReviewsDismissed: true,
    });
    expect(() =>
      verifyEffectiveMainRules(effective, [
        { ...details[0], bypass_actors: [{ actor_id: 5 }] },
        details[1],
      ])
    ).toThrow();
    expect(() =>
      verifyEffectiveMainRules(effective, details.slice(0, 1))
    ).toThrow();
    expect(() =>
      verifyEffectiveMainRules(
        effective.filter((value) => value.type !== "required_status_checks"),
        details
      )
    ).toThrow();
  });
  it("pins external Docker images and every workflow action and keeps the security scan inside verify", () => {
    for (const file of [
      "Dockerfile",
      "Dockerfile.e2e",
      "Dockerfile.database",
      "Dockerfile.tunnel",
    ]) {
      const lines = readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => /^FROM [^ ]+[:/]/.test(line));
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines)
        expect(line).toMatch(/@sha256:[a-f0-9]{64}(?:\s|$)/);
    }
    const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
    for (const action of workflow.matchAll(/uses:\s*([^\s#]+)/g))
      expect(action[1]).toMatch(/@[a-f0-9]{40}$/);
    expect(workflow).toContain("run: sh scripts/security-scan.sh");
    expect(workflow).not.toContain("continue-on-error:");
  });
  it("requires the CI job that the workflow actually runs, on an up-to-date branch", () => {
    const checks = rule(baseline, "required_status_checks")!.parameters!;
    expect(checks.strict_required_status_checks_policy).toBe(true);
    const contexts = (
      checks.required_status_checks as { context: string }[]
    ).map((check) => check.context);
    const workflow = readFileSync(".github/workflows/ci.yml", "utf8").replace(
      /\r\n/g,
      "\n"
    );
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
  it("requires another developer's approval of the latest changes without bypass", () => {
    expect(rule(review, "pull_request")!.parameters).toMatchObject({
      required_approving_review_count: 1,
      dismiss_stale_reviews_on_push: true,
      require_last_push_approval: true,
    });
    expect(review.bypass_actors).toEqual([]);
    expect(review.rules.map((candidate) => candidate.type)).toEqual([
      "pull_request",
    ]);
  });
  it("applies both rulesets to the default branch", () => {
    for (const set of [baseline, review])
      expect(set.conditions.ref_name.include).toEqual(["~DEFAULT_BRANCH"]);
  });
});
