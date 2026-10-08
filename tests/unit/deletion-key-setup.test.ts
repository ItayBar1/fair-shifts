import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  logPublicKeys,
  logSigner,
  matchingLogKeys,
} from "../../src/server/operations/deletion-log-keys";

const roots: string[] = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true }))
);
const generate = (root: string) =>
  execFileSync(
    process.execPath,
    ["--import", "tsx", "scripts/init-deletion-keys.ts", root],
    { encoding: "utf8", stdio: "pipe" }
  );
const env = (text: string) =>
  Object.fromEntries(
    text
      .trim()
      .split("\n")
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      })
  );

describe("existing deployment deletion-key setup", () => {
  it("writes matching random keys privately, exposes public verification only and keeps recovery unconfirmed", () => {
    const root = mkdtempSync(join(tmpdir(), "deletion-keys-"));
    roots.push(root);
    const output = generate(root);
    const worker = env(readFileSync(join(root, "worker-secrets.env"), "utf8"));
    const publicText = readFileSync(
      join(root, "deletion-public-keys.env"),
      "utf8"
    );
    const publicEnv = env(publicText);
    expect(worker.DELETION_LOG_KEY_RECOVERY_CONFIRMED).toBe("false");
    expect(
      matchingLogKeys(
        logSigner(worker)!,
        logPublicKeys(undefined, publicEnv.DELETION_LOG_PUBLIC_KEYS)
      )
    ).toBe(true);
    expect(publicText).not.toContain(worker.DELETION_LOG_PRIVATE_KEY);
    expect(output).not.toContain(worker.DELETION_LOG_PRIVATE_KEY);
    for (const file of ["worker-secrets.env", "deletion-public-keys.env"])
      expect(statSync(join(root, file)).mode & 0o777).toBe(0o600);
  });
  it("refuses a second setup without overwriting either key file", () => {
    const root = mkdtempSync(join(tmpdir(), "deletion-keys-"));
    roots.push(root);
    generate(root);
    const path = join(root, "worker-secrets.env");
    const before = readFileSync(path, "utf8");
    expect(() => generate(root)).toThrow();
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});
