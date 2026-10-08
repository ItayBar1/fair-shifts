import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { AppError } from "../../src/server/errors";
import { errorResponse } from "../../src/server/http";
import {
  diagnosticActionTypes,
  logGoogleRejection,
} from "../../src/server/diagnostics";

afterEach(() => vi.restoreAllMocks());

describe("safe request diagnostics (#120)", () => {
  it("logs one English line with method, path, known action and the first source frame only", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new TypeError(
      "private@example.invalid access_token=secret Cookie=session-value"
    );
    error.stack = `${error.name}: ${error.message}\n    at driver (/app/node_modules/driver/index.js:1:2)\n    at execute (/app/src/server/actions.ts:368:25)\n    at POST (/app/src/app/api/v1/actions/route.ts:9:3)`;
    const request = new Request(
      "https://private.example.invalid/api/v1/actions?token=query-secret",
      {
        method: "POST",
        headers: {
          cookie: "session=cookie-secret",
          authorization: "Bearer header-secret",
        },
        body: JSON.stringify({
          type: "duty.create",
          payload: {
            email: "body@example.invalid",
            personalNumber: "9999999",
            name: "Private Name",
          },
        }),
      }
    );
    const response = errorResponse(error, {
      request,
      actionType: "duty.create",
    });
    expect(log.mock.calls).toEqual([
      [
        "Request failed TypeError POST /api/v1/actions action=duty.create at src/server/actions.ts:368",
      ],
    ]);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: "internal_error",
        message: "הפעולה לא הושלמה. נסו שוב או פנו לאחראי",
      },
    });
    expect(request.bodyUsed).toBe(false);
  });

  it.each([
    "private@example.invalid",
    "soldier.PrivateName",
    "account.9999999",
    "duty.create\nforged-line",
    { type: "duty.create", email: "private@example.invalid" },
    null,
  ])("never logs unknown action input %j", (actionType) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    errorResponse(new Error("secret"), {
      request: new Request("https://example.invalid/api/v1/actions"),
      actionType,
    });
    expect(log.mock.calls).toEqual([
      ["Request failed Error GET /api/v1/actions action=other at unknown"],
    ]);
  });

  it("rejects personal path segments and error names and ignores message text and fabricated source files", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new Error("secret");
    error.name = "private@example.invalid\nInjected log";
    error.stack =
      "Error: at src/server/auth/index.ts:1:1\n    at leak (/app/src/server/private-name.ts:2:3)\n    at leak (/app/src/server/../private@example.invalid.ts:2:3)\n    at leak (/app/src/server/auth/index.ts?token=secret:2:3)";
    errorResponse(error, {
      request: {
        method: "POST\nsecret",
        url: "https://secret.invalid/api/auth/private@example.invalid?token=secret",
      },
    });
    expect(log.mock.calls).toEqual([
      ["Request failed unknown unknown unknown at unknown"],
    ]);
  });

  it("handles source-map frame syntax, Windows separators, missing stacks and non-error throws", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new Error("secret");
    for (const frame of [
      "    at work (webpack-internal:///(rsc)/./src/server/auth/index.ts:42:7)",
      "    at work (C:\\app\\src\\server\\auth\\index.ts:42:7)",
    ]) {
      error.stack = `Error: secret\n${frame}`;
      errorResponse(error);
      expect(log.mock.lastCall).toEqual([
        "Request failed Error unknown unknown at src/server/auth/index.ts:42",
      ]);
    }
    error.stack = undefined;
    errorResponse(error);
    expect(log.mock.lastCall).toEqual([
      "Request failed Error unknown unknown at unknown",
    ]);
    errorResponse({
      message: "private@example.invalid",
      token: "secret",
      stack: "src/server/auth/index.ts:42:7",
    });
    expect(log.mock.lastCall).toEqual([
      "Request failed unknown unknown unknown at unknown",
    ]);
  });

  it("preserves expected application, validation and uniqueness responses without logging", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const application = errorResponse(
      new AppError("forbidden", "אין הרשאה", 403)
    );
    expect(application.status).toBe(403);
    expect(await application.json()).toMatchObject({
      error: { code: "forbidden", message: "אין הרשאה" },
    });
    expect(errorResponse(new ZodError([])).status).toBe(422);
    expect(
      errorResponse({
        cause: { code: "23505", message: "private@example.invalid" },
      }).status
    ).toBe(409);
    expect(log).not.toHaveBeenCalled();
  });

  it("covers every currently dispatched action with an explicit safe name", () => {
    const source = readFileSync("src/server/actions.ts", "utf8");
    const types = [...source.matchAll(/case "([^"]+)":/g)].map(
      (match) => match[1]
    );
    expect([...diagnosticActionTypes].sort()).toEqual(types.sort());
  });
});

describe("safe Google callback diagnostics (#120)", () => {
  const request = new Request(
    "https://example.invalid/api/auth/callback/google?code=token-secret&state=state-secret",
    {
      headers: { cookie: "session=cookie-secret" },
    }
  );
  it.each([
    "signup_disabled",
    "account_not_linked",
    "unable_to_link_account",
    "state_not_found",
    "state_mismatch",
    "invalid_code",
  ])("logs exact known rejection %s", (code) => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    logGoogleRejection(
      request,
      Response.redirect(
        `https://example.invalid/login?error=${code}&error_description=private%40example.invalid&token=token-secret`
      )
    );
    expect(log.mock.calls).toEqual([[`Google sign-in rejected ${code}`]]);
  });

  it.each([
    "",
    "private@example.invalid",
    "signup_disabled token-secret",
    "access_denied\nforged-line",
    "user-9999999",
  ])(
    "maps unknown rejection %j to other without logging anything else",
    (code) => {
      const log = vi.spyOn(console, "warn").mockImplementation(() => {});
      logGoogleRejection(
        request,
        new Response("private body", {
          status: 302,
          headers: {
            location: `/login?error=${encodeURIComponent(code)}&error_description=secret`,
          },
        })
      );
      expect(log.mock.calls).toEqual([["Google sign-in rejected other"]]);
    }
  );

  it("does not log successful callbacks, ordinary responses, other endpoints or a POST-to-GET callback replay", () => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    logGoogleRejection(request, Response.redirect("https://example.invalid/"));
    logGoogleRejection(request, Response.json({ error: "secret" }));
    logGoogleRejection(request, new Response(null, { status: 302 }));
    logGoogleRejection(
      request,
      new Response(null, {
        status: 302,
        headers: {
          location: "/?error=invalid_code",
          "set-cookie": "better-auth.session_token=private-session; HttpOnly",
        },
      })
    );
    const rejected = Response.redirect(
      "https://example.invalid/login?error=invalid_code"
    );
    logGoogleRejection(
      new Request("https://example.invalid/api/auth/request-code"),
      rejected
    );
    logGoogleRejection(new Request(request.url, { method: "POST" }), rejected);
    expect(log).not.toHaveBeenCalled();
  });
});
