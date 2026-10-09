import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getActor, getAuth } from "../../src/server/auth";
import { executeAction } from "../../src/server/actions";
import { POST as actions } from "../../src/app/api/v1/actions/route";
import { GET as auth } from "../../src/app/api/auth/[...all]/route";
import { GET as state } from "../../src/app/api/v1/state/route";
import { GET as assignments } from "../../src/app/api/v1/my-assignments/route";
import { POST as imports } from "../../src/app/api/v1/imports/route";
import { GET as template } from "../../src/app/api/v1/imports/template/route";

vi.mock("../../src/server/auth", () => ({
  getActor: vi.fn(),
  getAuth: vi.fn(),
}));
vi.mock("../../src/server/actions", () => ({ executeAction: vi.fn() }));
vi.mock("../../src/server/auth/rate-limit", () => ({
  enforceAuthRateLimit: vi.fn(),
}));
vi.mock("../../src/server/state", () => ({ readState: vi.fn() }));
vi.mock("../../src/server/my-assignments", () => ({
  readMyAssignments: vi.fn(),
}));
vi.mock("../../src/server/import-workbook", () => ({
  parseImportWorkbook: vi.fn(),
  createImportTemplate: vi.fn(),
}));
vi.mock("../../src/server/repository", () => ({ manager: vi.fn() }));
vi.mock("../../src/server/db", () => ({ db: {} }));

const origin = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
let failure: TypeError;
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  failure = new TypeError(
    "private@example.invalid token-secret body-secret cookie-secret"
  );
  failure.stack = `${failure.name}: ${failure.message}\n    at work (/app/src/server/auth/index.ts:368:12)`;
});
afterEach(() => vi.restoreAllMocks());

describe("HTTP route failure context (#120)", () => {
  it.each([
    ["GET", "/api/v1/state", state],
    ["GET", "/api/v1/my-assignments", assignments],
    ["POST", "/api/v1/imports", imports],
    ["GET", "/api/v1/imports/template", template],
  ] as const)(
    "records %s %s without query or identity",
    async (method, path, handler) => {
      vi.mocked(getActor).mockRejectedValue(failure);
      const response = await handler(
        new Request(
          `${origin}${path}?mail=user-secret&email=private@example.invalid`,
          { method, headers: { origin, cookie: "session=cookie-secret" } }
        )
      );
      expect(response.status).toBe(500);
      expect(vi.mocked(console.error).mock.calls).toEqual([
        [
          `Request failed TypeError ${method} ${path} at src/server/auth/index.ts:368`,
        ],
      ]);
    }
  );

  it("logs action type after the bounded parse without re-reading or exposing its payload", async () => {
    vi.mocked(getActor).mockResolvedValue({
      id: "user-secret",
      name: "Private Name",
      role: "manager",
      securityEpoch: 1,
    });
    vi.mocked(executeAction).mockRejectedValue(failure);
    const command = {
      type: "duty.create",
      payload: { name: "body-secret", email: "private@example.invalid" },
      idempotencyKey: "key-secret",
    };
    const response = await actions(
      new Request(`${origin}/api/v1/actions?token=query-secret`, {
        method: "POST",
        headers: { origin, cookie: "session=cookie-secret" },
        body: JSON.stringify(command),
      })
    );
    expect(response.status).toBe(500);
    expect(executeAction).toHaveBeenCalledWith(
      expect.objectContaining({ id: "user-secret" }),
      command
    );
    expect(vi.mocked(console.error).mock.calls).toEqual([
      [
        "Request failed TypeError POST /api/v1/actions action=duty.create at src/server/auth/index.ts:368",
      ],
    ]);
  });

  it("logs action failure before parsing with no invented action type", async () => {
    vi.mocked(getActor).mockRejectedValue(failure);
    const response = await actions(
      new Request(`${origin}/api/v1/actions`, {
        method: "POST",
        headers: { origin },
        body: "body-secret",
      })
    );
    expect(response.status).toBe(500);
    expect(vi.mocked(console.error).mock.calls).toEqual([
      [
        "Request failed TypeError POST /api/v1/actions at src/server/auth/index.ts:368",
      ],
    ]);
  });

  it("records unexpected Google handler failures without the OAuth code, state or cookie", async () => {
    vi.mocked(getAuth).mockReturnValue({
      handler: vi.fn().mockRejectedValue(failure),
    } as unknown as ReturnType<typeof getAuth>);
    const response = await auth(
      new Request(
        `${origin}/api/auth/callback/google?code=token-secret&state=state-secret`,
        { headers: { cookie: "oauth=cookie-secret" } }
      )
    );
    expect(response.status).toBe(500);
    expect(vi.mocked(console.error).mock.calls).toEqual([
      [
        "Request failed TypeError GET /api/auth/callback/google at src/server/auth/index.ts:368",
      ],
    ]);
  });
});
