import { z } from "zod";

const severity = z.enum(["info", "low", "moderate", "high", "critical"]);
export type Finding = {
  scope: "dependencies" | "image";
  id: string;
  package: string;
  version: string;
  severity: string;
};
const review = z
  .object({
    pullRequest: z.number().int().positive(),
    reviewId: z.number().int().positive(),
    commit: z.string().regex(/^[a-f0-9]{40}$/),
  })
  .strict();
export const exceptionSchema = z
  .object({
    scope: z.enum(["dependencies", "image"]),
    id: z.string().regex(/^(CVE-\d{4}-\d+|GHSA-[a-z0-9-]+)$/),
    package: z.string().min(1),
    version: z.string().min(1),
    reason: z.string().min(30).max(2000),
    expiresAt: z.iso.datetime(),
    review: review.nullable(),
    patch: z
      .object({
        file: z.string().regex(/^patches\/[A-Za-z0-9@._-]+\.patch$/),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .optional(),
  })
  .strict();
export type SecurityException = z.infer<typeof exceptionSchema>;
export const exceptionFile = z
  .object({
    version: z.literal(1),
    exceptions: z.array(exceptionSchema).max(100),
  })
  .strict();
export const exceptionIdentity = (value: SecurityException) =>
  JSON.stringify([
    value.scope,
    value.id,
    value.package,
    value.version,
    value.reason,
    value.expiresAt,
    value.patch ?? null,
  ]);

export function parseExceptions(input: unknown, now = new Date()) {
  const { exceptions } = exceptionFile.parse(input);
  const seen = new Set<string>();
  for (const item of exceptions) {
    const expiry = new Date(item.expiresAt).getTime();
    if (expiry <= now.getTime() || expiry > now.getTime() + 30 * 86400_000)
      throw new Error("Security exception is expired or exceeds 30 days");
    const key = JSON.stringify([
      item.scope,
      item.id,
      item.package,
      item.version,
    ]);
    if (seen.has(key)) throw new Error("Duplicate security exception");
    seen.add(key);
  }
  return exceptions;
}

export function trivyFindings(
  input: unknown,
  scope: Finding["scope"],
  now = new Date()
): Finding[] {
  const item = z
    .object({
      SchemaVersion: z.literal(2),
      CreatedAt: z.iso.datetime({ offset: true }),
      Metadata: z
        .object({
          OS: z
            .object({ Family: z.string().min(1) })
            .passthrough()
            .optional(),
        })
        .passthrough()
        .optional(),
      Results: z.array(
        z
          .object({
            Type: z.string(),
            Packages: z.array(z.unknown()).optional(),
            Vulnerabilities: z
              .array(
                z
                  .object({
                    VulnerabilityID: z.string().min(1),
                    PkgName: z.string().min(1),
                    InstalledVersion: z.string().min(1),
                    Severity: z.enum([
                      "UNKNOWN",
                      "LOW",
                      "MEDIUM",
                      "HIGH",
                      "CRITICAL",
                    ]),
                  })
                  .passthrough()
              )
              .optional(),
          })
          .passthrough()
      ),
    })
    .passthrough()
    .parse(input);
  const created = new Date(item.CreatedAt).getTime();
  if (created < now.getTime() - 86400_000 || created > now.getTime() + 300_000)
    throw new Error("Scan report is stale or has an invalid time");
  if (
    !item.Results.some(
      (result) =>
        result.Packages?.length && (scope === "image" || result.Type === "pnpm")
    )
  )
    throw new Error("Scan did not identify the required packages");
  if (scope === "image" && !item.Metadata?.OS?.Family)
    throw new Error("Production image operating system was not scanned");
  return item.Results.flatMap((result) =>
    (result.Vulnerabilities || []).map((value) => ({
      scope,
      id: value.VulnerabilityID,
      package: value.PkgName,
      version: value.InstalledVersion,
      severity: value.Severity.toLowerCase(),
    }))
  );
}

/** The registry audit catches newly published advisories before Trivy's DB sync. */
export function auditFindings(input: unknown): Finding[] {
  const report = z
    .object({
      advisories: z.record(
        z.string(),
        z
          .object({
            module_name: z.string().min(1),
            github_advisory_id: z.string().min(1),
            severity,
            findings: z
              .array(z.object({ version: z.string().min(1) }).passthrough())
              .min(1),
          })
          .passthrough()
      ),
      metadata: z
        .object({
          dependencies: z.number().positive(),
          vulnerabilities: z.object({
            info: z.number(),
            low: z.number(),
            moderate: z.number(),
            high: z.number(),
            critical: z.number(),
          }),
        })
        .passthrough(),
    })
    .passthrough()
    .parse(input);
  if ("error" in report) throw new Error("Dependency audit failed");
  const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
  const findings = Object.values(report.advisories).flatMap((entry) => {
    counts[entry.severity]++;
    return entry.findings.map((item) => ({
      scope: "dependencies" as const,
      id: entry.github_advisory_id,
      package: entry.module_name,
      version: item.version,
      severity: entry.severity,
    }));
  });
  for (const key of Object.keys(counts) as (keyof typeof counts)[])
    if (counts[key] !== report.metadata.vulnerabilities[key])
      throw new Error("Dependency audit findings are incomplete");
  return findings;
}

export async function verifyExceptionReviews(
  exceptions: SecurityException[],
  request: (path: string) => Promise<unknown>,
  contextCommit?: string
) {
  for (const item of exceptions) {
    let evidence = item.review;
    // The first exception PR cannot record its future review ID. Resolve an
    // approval of its current head without pushing review metadata (which would
    // dismiss that approval). A merge commit resolves to the same reviewed PR.
    if (!evidence && contextCommit && /^[a-f0-9]{40}$/.test(contextCommit)) {
      const candidates = z
        .array(
          z
            .object({
              number: z.number().int().positive(),
              head: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) }),
              user: z.object({ login: z.string() }),
            })
            .passthrough()
        )
        .parse(await request(`/commits/${contextCommit}/pulls`));
      for (const candidate of candidates) {
        const reviews = z
          .array(
            z
              .object({
                id: z.number().int().positive(),
                state: z.string(),
                commit_id: z.string(),
                user: z.object({ login: z.string(), type: z.string() }),
              })
              .passthrough()
          )
          .parse(
            await request(`/pulls/${candidate.number}/reviews?per_page=100`)
          );
        if (reviews.length === 100)
          throw new Error("Review history is incomplete");
        const latest = new Map(
          reviews.map((value) => [value.user.login, value])
        );
        const approved = [...latest.values()].find(
          (value) =>
            value.state === "APPROVED" &&
            value.commit_id === candidate.head.sha &&
            value.user.type === "User" &&
            value.user.login !== candidate.user.login
        );
        if (approved) {
          evidence = {
            pullRequest: candidate.number,
            reviewId: approved.id,
            commit: candidate.head.sha,
          };
          break;
        }
      }
    }
    if (!evidence)
      throw new Error("Security exception requires an approved review");
    const { pullRequest, reviewId, commit } = evidence;
    const approved = z
      .object({
        state: z.literal("APPROVED"),
        commit_id: z.literal(commit),
        user: z.object({ login: z.string(), type: z.literal("User") }),
      })
      .passthrough()
      .parse(await request(`/pulls/${pullRequest}/reviews/${reviewId}`));
    const pr = z
      .object({
        user: z.object({ login: z.string() }),
        head: z.object({ sha: z.literal(commit) }),
      })
      .passthrough()
      .parse(await request(`/pulls/${pullRequest}`));
    if (approved.user.login === pr.user.login)
      throw new Error("Security exception cannot be self-approved");
    const history = z
      .array(
        z
          .object({
            id: z.number().int().positive(),
            state: z.string(),
            user: z.object({ login: z.string() }),
          })
          .passthrough()
      )
      .parse(await request(`/pulls/${pullRequest}/reviews?per_page=100`));
    if (history.length === 100) throw new Error("Review history is incomplete");
    const latest = history
      .filter(
        (value) =>
          value.user.login === approved.user.login &&
          value.state !== "COMMENTED"
      )
      .at(-1);
    if (latest?.id !== reviewId || latest.state !== "APPROVED")
      throw new Error("Security exception approval was superseded");
    const permission = z
      .object({ permission: z.enum(["write", "maintain", "admin"]) })
      .passthrough()
      .parse(
        await request(
          `/collaborators/${encodeURIComponent(approved.user.login)}/permission`
        )
      );
    if (!permission.permission) throw new Error("Reviewer needs write access");
    const file = z
      .object({ encoding: z.literal("base64"), content: z.string() })
      .passthrough()
      .parse(
        await request(`/contents/config/security-exceptions.json?ref=${commit}`)
      );
    const historical = exceptionFile.parse(
      JSON.parse(Buffer.from(file.content, "base64").toString("utf8"))
    );
    if (
      !historical.exceptions.some(
        (old) => exceptionIdentity(old) === exceptionIdentity(item)
      )
    )
      throw new Error("Reviewed exception differs from the current exception");
  }
}

export function blockingFindings(
  findings: Finding[],
  exceptions: SecurityException[]
) {
  return findings.filter(
    (item) =>
      ["high", "critical"].includes(item.severity) &&
      !exceptions.some(
        (allow) =>
          allow.scope === item.scope &&
          allow.id === item.id &&
          allow.package === item.package &&
          allow.version === item.version
      )
  );
}
