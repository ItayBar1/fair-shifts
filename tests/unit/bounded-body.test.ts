import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTH_BODY_LIMIT,
  ACTION_BODY_LIMIT,
  boundedAuthRequest,
  parseBoundedJson,
  readBoundedBody,
} from "../../src/server/bounded-body";
import { POST as actionRoute } from "../../src/app/api/v1/actions/route";
import { POST as authRoute } from "../../src/app/api/auth/[...all]/route";
import { getActor, getAuth } from "../../src/server/auth";
import { executeAction } from "../../src/server/actions";
import { enforceAuthRateLimit } from "../../src/server/auth/rate-limit";

vi.mock("../../src/server/auth", () => ({
  getActor: vi.fn(),
  getAuth: vi.fn(),
}));
vi.mock("../../src/server/actions", () => ({ executeAction: vi.fn() }));
vi.mock("../../src/server/auth/rate-limit", () => ({
  enforceAuthRateLimit: vi.fn(),
}));
const origin = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
function streamed(bytes: number, length?: string, path = "/api/v1/actions") {
  const cancelled = vi.fn();
  let left = bytes;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!left) return controller.close();
      const size = Math.min(left, 64 * 1024);
      left -= size;
      controller.enqueue(new Uint8Array(size).fill(0x20));
    },
    cancel: cancelled,
  });
  return {
    request: new Request(`${origin}${path}`, {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/json",
        ...(length ? { "content-length": length } : {}),
      },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" }),
    cancelled,
  };
}
const nested = (depth: number) => "[".repeat(depth) + "0" + "]".repeat(depth);
const jsonRequest = (value: string, type = "application/json") =>
  new Request(`${origin}/api/auth/verify-code`, {
    method: "POST",
    headers: { origin, "content-type": type },
    body: value,
  });
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getActor).mockResolvedValue({
    id: "synthetic",
    role: "manager",
    name: "Synthetic",
    soldierId: "00000000-0000-4000-8000-000000000001",
    securityEpoch: 1,
  });
  vi.mocked(executeAction).mockResolvedValue({ saved: true });
  vi.mocked(getAuth).mockReturnValue({
    handler: vi.fn(async (request: Request) =>
      Response.json(await request.json())
    ),
  } as unknown as ReturnType<typeof getAuth>);
});
describe("bounded JSON before command hashing and transactions", () => {
  it.each([undefined, "1"])(
    "counts streamed action bodies despite a missing or false length %s and cancels the source",
    async (length) => {
      const { request, cancelled } = streamed(
        ACTION_BODY_LIMIT + 3 * 65536,
        length
      );
      expect((await actionRoute(request)).status).toBe(413);
      expect(cancelled).toHaveBeenCalled();
      expect(executeAction).not.toHaveBeenCalled();
    }
  );
  it("accepts the exact byte limit and rejects a declared overflow before reading", async () => {
    expect(
      (
        await readBoundedBody(
          streamed(AUTH_BODY_LIMIT).request,
          AUTH_BODY_LIMIT
        )
      ).length
    ).toBe(AUTH_BODY_LIMIT);
    const { request, cancelled } = streamed(1, String(AUTH_BODY_LIMIT + 1));
    await expect(
      readBoundedBody(request, AUTH_BODY_LIMIT)
    ).rejects.toMatchObject({ status: 413 });
    expect(cancelled).toHaveBeenCalled();
  });
  it("allows depth 32, ignores quoted brackets and rejects depth 33 before execution", async () => {
    expect(parseBoundedJson(Buffer.from(nested(32)))).toBeInstanceOf(Array);
    expect(
      parseBoundedJson(
        Buffer.from(JSON.stringify({ value: '[{\\"'.repeat(100) }))
      )
    ).toHaveProperty("value");
    expect((await actionRoute(jsonRequest(nested(33)))).status).toBe(413);
    expect(executeAction).not.toHaveBeenCalled();
  });
  it("rejects malformed JSON and invalid UTF-8 without opening the command", async () => {
    expect((await actionRoute(jsonRequest("{invalid"))).status).toBe(400);
    expect(() => parseBoundedJson(Buffer.from([0xff]))).toThrow();
    expect(executeAction).not.toHaveBeenCalled();
  });
  it("limits authentication to 16KiB before rate-limit or authentication transactions", async () => {
    expect(
      (
        await authRoute(
          streamed(AUTH_BODY_LIMIT + 1, undefined, "/api/auth/verify-code")
            .request
        )
      ).status
    ).toBe(413);
    expect(enforceAuthRateLimit).not.toHaveBeenCalled();
    expect(getAuth).not.toHaveBeenCalled();
  });
  it("rejects deep authentication JSON even with a false media type and replays a bounded valid body", async () => {
    expect(
      (await authRoute(jsonRequest(nested(33), "text/plain"))).status
    ).toBe(413);
    expect(getAuth).not.toHaveBeenCalled();
    const bounded = await boundedAuthRequest(
      jsonRequest('{"code":"synthetic"}')
    );
    expect(await bounded.json()).toEqual({ code: "synthetic" });
    const response = await authRoute(jsonRequest('{"code":"synthetic"}'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ code: "synthetic" });
  });
});
