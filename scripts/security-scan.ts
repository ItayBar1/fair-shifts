import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  auditFindings,
  blockingFindings,
  parseExceptions,
  trivyFindings,
  verifyExceptionReviews,
} from "../src/domain/supply-chain";

const read = (file: string) => {
  if (statSync(file).size > 64 * 1024 * 1024)
    throw new Error("Scan report is too large");
  return JSON.parse(readFileSync(file, "utf8"));
};
try {
  const directory = process.argv[2];
  if (!directory) throw new Error("Security report directory is required");
  const findings = [
    ...auditFindings(read(`${directory}/audit.json`)),
    ...trivyFindings(read(`${directory}/dependencies.json`), "dependencies"),
    ...trivyFindings(read(`${directory}/production.json`), "image"),
    ...trivyFindings(read(`${directory}/database.json`), "image"),
    ...trivyFindings(read(`${directory}/tunnel.json`), "image"),
  ];
  console.log(
    JSON.stringify({
      findings: findings.length,
      unreviewedBlocking: blockingFindings(findings, []).length,
    })
  );
  const exceptions = parseExceptions(read("config/security-exceptions.json"));
  for (const item of exceptions)
    if (
      item.patch &&
      createHash("sha256")
        .update(readFileSync(item.patch.file))
        .digest("hex") !== item.patch.sha256
    )
      throw new Error("Security exception mitigation patch changed");
  await verifyExceptionReviews(
    exceptions,
    async (path) => {
      const response = await fetch(
        `https://api.github.com/repos/ItayBar1/fair-shifts${path}`,
        {
          headers: {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            ...(process.env.GITHUB_TOKEN
              ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
              : {}),
          },
          signal: AbortSignal.timeout(10000),
        }
      );
      if (!response.ok)
        throw new Error("Could not verify the security exception review");
      return response.json();
    },
    process.env.SECURITY_REVIEW_COMMIT
  );
  const blocking = blockingFindings(findings, exceptions);
  console.log(
    JSON.stringify({
      findings: findings.length,
      blocking: blocking.length,
      reviewedExceptions: exceptions.length,
    })
  );
  for (const item of blocking) console.error(JSON.stringify(item));
  if (blocking.length) process.exitCode = 1;
} catch {
  console.error(
    "Security verification failed: scans and unexpired review evidence are required"
  );
  process.exitCode = 1;
}
