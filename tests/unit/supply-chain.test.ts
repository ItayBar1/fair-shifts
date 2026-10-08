import { describe, expect, it } from "vitest";
import {
  auditFindings,
  blockingFindings,
  parseExceptions,
  trivyFindings,
  verifyExceptionReviews,
  type SecurityException,
} from "../../src/domain/supply-chain";

const now = new Date("2026-10-08T00:00:00Z");
const finding = {
  scope: "image" as const,
  id: "CVE-2026-1234",
  package: "package",
  version: "1.0",
  severity: "high",
};
const allow: SecurityException = {
  ...finding,
  reason: "Upstream fix pending; isolated service has no exposed parser",
  expiresAt: "2026-10-09T00:00:00Z",
  review: { pullRequest: 1, reviewId: 2, commit: "a".repeat(40) },
};
const exception = {
  scope: allow.scope,
  id: allow.id,
  package: allow.package,
  version: allow.version,
  reason: allow.reason,
  expiresAt: allow.expiresAt,
  review: allow.review,
};
const report = {
  SchemaVersion: 2,
  CreatedAt: now.toISOString(),
  Metadata: { OS: { Family: "debian" } },
  Results: [
    {
      Type: "pnpm",
      Packages: [{ Name: "package" }],
      Vulnerabilities: [
        {
          VulnerabilityID: finding.id,
          PkgName: finding.package,
          InstalledVersion: finding.version,
          Severity: "HIGH",
        },
      ],
    },
  ],
};

describe("supply-chain verification", () => {
  it("blocks high and critical findings and limits exceptions to the exact package, version and scope", () => {
    expect(blockingFindings([finding], [])).toEqual([finding]);
    expect(
      blockingFindings([{ ...finding, severity: "critical" }], [])
    ).toHaveLength(1);
    expect(blockingFindings([finding], [exception])).toEqual([]);
    for (const item of [
      { ...finding, version: "2.0" },
      { ...finding, scope: "dependencies" as const },
      { ...finding, package: "other" },
    ])
      expect(blockingFindings([item], [exception])).toEqual([item]);
  });
  it("rejects expired, overly long, ambiguous or duplicate exception records", () => {
    expect(
      parseExceptions({ version: 1, exceptions: [exception] }, now)
    ).toHaveLength(1);
    for (const items of [
      [{ ...exception, expiresAt: now.toISOString() }],
      [{ ...exception, expiresAt: "2027-01-01T00:00:00Z" }],
      [exception, exception],
      [{ ...exception, reason: "skip" }],
      [{ ...exception, ignored: true }],
    ])
      expect(() =>
        parseExceptions({ version: 1, exceptions: items }, now)
      ).toThrow();
  });
  it("requires actual approval by another writer for the identical exception at the reviewed commit", async () => {
    const request = async (path: string): Promise<unknown> => {
      if (path.includes("reviews?"))
        return [{ id: 2, state: "APPROVED", user: { login: "second" } }];
      if (path.includes("/reviews/"))
        return {
          state: "APPROVED",
          commit_id: exception.review!.commit,
          user: { login: "second", type: "User" },
        };
      if (path.includes("/permission")) return { permission: "write" };
      if (path.includes("/contents/"))
        return {
          encoding: "base64",
          content: Buffer.from(
            JSON.stringify({
              version: 1,
              exceptions: [{ ...exception, review: null }],
            })
          ).toString("base64"),
        };
      return {
        user: { login: "author" },
        head: { sha: exception.review!.commit },
      };
    };
    await expect(
      verifyExceptionReviews([exception], request)
    ).resolves.toBeUndefined();
    await expect(
      verifyExceptionReviews([{ ...exception, review: null }], request)
    ).rejects.toThrow();
    await expect(
      verifyExceptionReviews(
        [
          {
            ...exception,
            reason: "A different justification after the approval was recorded",
          },
        ],
        request
      )
    ).rejects.toThrow("differs");
    for (const [match, value] of [
      ["/reviews/", { state: "DISMISSED" }],
      ["/permission", { permission: "read" }],
      ["/pulls/1", { user: { login: "second" } }],
    ] as const)
      await expect(
        verifyExceptionReviews([exception], (path) =>
          path === match || (match !== "/pulls/1" && path.includes(match))
            ? Promise.resolve(value)
            : request(path)
        )
      ).rejects.toThrow();
  });
  it("resolves the first exception approval from the current PR head without a metadata push that dismisses it", async () => {
    const commit = "b".repeat(40);
    const entry = { ...exception, review: null };
    const request = async (path: string): Promise<unknown> => {
      if (path.includes("/commits/"))
        return [
          { number: 3, head: { sha: commit }, user: { login: "author" } },
        ];
      const approval = {
        id: 4,
        state: "APPROVED",
        commit_id: commit,
        user: { login: "second", type: "User" },
      };
      if (path.includes("reviews?")) return [approval];
      if (path.endsWith("/reviews/4")) return approval;
      if (path.includes("/permission")) return { permission: "write" };
      if (path.includes("/contents/"))
        return {
          encoding: "base64",
          content: Buffer.from(
            JSON.stringify({ version: 1, exceptions: [entry] })
          ).toString("base64"),
        };
      return { user: { login: "author" }, head: { sha: commit } };
    };
    await expect(
      verifyExceptionReviews([entry], request, commit)
    ).resolves.toBeUndefined();
    for (const state of ["DISMISSED", "COMMENTED", "CHANGES_REQUESTED"])
      await expect(
        verifyExceptionReviews(
          [entry],
          (path) =>
            path.includes("reviews?")
              ? Promise.resolve([
                  {
                    id: 4,
                    state,
                    commit_id: commit,
                    user: { login: "second", type: "User" },
                  },
                ])
              : request(path),
          commit
        )
      ).rejects.toThrow();
    await expect(
      verifyExceptionReviews(
        [entry],
        (path) =>
          path.includes("reviews?")
            ? Promise.resolve([
                {
                  id: 4,
                  state: "APPROVED",
                  commit_id: "c".repeat(40),
                  user: { login: "second", type: "User" },
                },
              ])
            : request(path),
        commit
      )
    ).rejects.toThrow();
  });
  it("fails closed for empty, stale, incomplete or unrecognized scan reports", () => {
    expect(trivyFindings(report, "image", now)).toEqual([finding]);
    for (const bad of [
      { ...report, Results: [] },
      { ...report, Metadata: {} },
      { ...report, CreatedAt: "2026-10-01T00:00:00Z" },
      { ...report, SchemaVersion: 1 },
    ])
      expect(() => trivyFindings(bad, "image", now)).toThrow();
    const audit = {
      advisories: {
        one: {
          module_name: "package",
          github_advisory_id: "GHSA-aaaa-bbbb-cccc",
          severity: "high",
          findings: [{ version: "1.0" }],
        },
      },
      metadata: {
        dependencies: 1,
        vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0 },
      },
    };
    expect(auditFindings(audit)).toHaveLength(1);
    expect(() => auditFindings({ ...audit, advisories: {} })).toThrow();
    expect(() => auditFindings({ error: "registry unavailable" })).toThrow();
  });
});
