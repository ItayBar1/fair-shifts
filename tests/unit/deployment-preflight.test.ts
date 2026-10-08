import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function deploy(container: string, runtime: string) {
  const directory = mkdtempSync(join(tmpdir(), "fs-deploy-preflight-"));
  const calls = join(directory, "calls");
  const docker = join(directory, "docker");
  writeFileSync(calls, "");
  writeFileSync(
    docker,
    `#!/bin/sh
case "$*" in
  *'ps -a -q db'*) printf '%s\\n' "$TEST_DATABASE_CONTAINER" ;;
  inspect*) printf '%s\\n' "$TEST_DATABASE_RUNTIME" ;;
  *) printf '%s\\n' "$*" >> "$TEST_DEPLOY_CALLS" ;;
esac
`
  );
  chmodSync(docker, 0o755);
  try {
    const result = spawnSync("sh", ["scripts/production.sh", "deploy", "db"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        APP_VERSION: "synthetic-test",
        FAIR_SHIFTS_CONFIG_DIR: directory,
        TEST_DEPLOY_CALLS: calls,
        TEST_DATABASE_CONTAINER: container,
        TEST_DATABASE_RUNTIME: runtime,
      },
    });
    return { ...result, calls: readFileSync(calls, "utf8") };
  } finally {
    rmSync(directory, { recursive: true });
  }
}

describe("database image deployment preflight", () => {
  it("rejects an existing legacy database before building, stopping or replacing any service", () => {
    for (const runtime of ["", "<no value>", "bookworm-pg18", "other"]) {
      const result = deploy("existing-database", runtime);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "Database image migration required before deployment"
      );
      expect(result.calls).toBe("");
    }
  });
  it("continues a fresh deployment or an already compatible database through operations before starting runtime", () => {
    for (const [container, runtime] of [
      ["", ""],
      ["existing-database", "alpine-pg18-v1"],
    ]) {
      const result = deploy(container, runtime);
      expect(result.status).toBe(0);
      expect(result.calls).toContain("up -d --wait db");
      expect(result.calls.indexOf("operations run")).toBeLessThan(
        result.calls.indexOf("up -d --wait --remove-orphans")
      );
    }
  });
});
