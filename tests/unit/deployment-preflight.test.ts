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

function deploy({
  missingFiles = false,
  invalidService = "",
  container = "",
  runtime = "",
} = {}) {
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
  *)
    printf '%s\\n' "$*" >> "$TEST_DEPLOY_CALLS"
    case "$*" in
      *'config --quiet'*) [ "$TEST_MISSING_FILES" != true ] || exit 1 ;;
      *'scripts/check-config.ts'*)
        case "$*" in *"--entrypoint node $TEST_INVALID_SERVICE "*) exit 1 ;; esac ;;
    esac ;;
esac
`
  );
  chmodSync(docker, 0o755);
  try {
    const result = spawnSync("sh", ["scripts/production.sh", "deploy", "app"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        APP_VERSION: "synthetic-test",
        FAIR_SHIFTS_CONFIG_DIR: directory,
        TEST_DEPLOY_CALLS: calls,
        TEST_DATABASE_CONTAINER: container,
        TEST_DATABASE_RUNTIME: runtime,
        TEST_MISSING_FILES: String(missingFiles),
        TEST_INVALID_SERVICE: invalidService,
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
      const result = deploy({ container: "existing-database", runtime });
      expect(result.status).toBe(78);
      expect(result.stderr).toContain(
        "Database image migration required before deployment"
      );
      expect(result.calls).not.toMatch(
        /build|up -d|stop worker app|--no-deps operations/
      );
    }
  });
  it("continues a fresh deployment or an already compatible database through operations before starting runtime", () => {
    for (const [container, runtime] of [
      ["", ""],
      ["existing-database", "alpine-pg18-v1"],
    ]) {
      const result = deploy({ container, runtime });
      expect(result.status).toBe(0);
      expect(result.calls).toContain("up -d --wait db");
      expect(result.calls.indexOf("--no-deps operations")).toBeLessThan(
        result.calls.indexOf("up -d --wait --remove-orphans")
      );
    }
  });
});

describe("deployment configuration preflight", () => {
  it("rejects missing runtime or operations env files before building or changing live services", () => {
    const result = deploy({ missingFiles: true });
    expect(result.status).toBe(78);
    expect(result.calls).toContain("--profile operations config --quiet");
    expect(result.calls).not.toMatch(
      /build|up -d|stop worker app|--no-deps operations/
    );
  });
  it("rejects invalid configuration for each service before changing live services", () => {
    for (const service of ["app", "worker", "operations"]) {
      const result = deploy({ invalidService: service });
      expect(result.status).toBe(78);
      expect(result.calls).toContain(`--entrypoint node ${service}`);
      expect(result.calls).not.toMatch(
        /up -d|stop worker app|--no-deps operations/
      );
    }
  });
  it("checks all three service configurations before starting the database or stopping runtime", () => {
    const result = deploy();
    expect(result.status).toBe(0);
    for (const service of ["app", "worker", "operations"]) {
      const check = result.calls.indexOf(`--entrypoint node ${service}`);
      expect(check).toBeGreaterThanOrEqual(0);
      expect(check).toBeLessThan(result.calls.indexOf("up -d --wait db"));
      expect(check).toBeLessThan(result.calls.indexOf("stop worker app"));
    }
    expect(result.calls).toContain(
      "scripts/run-runtime.mjs scripts/check-config.ts"
    );
    expect(result.calls).not.toContain("--import tsx");
  });
});
