import { vi } from "vitest";

/**
 * A stand-in for the Google endpoints the calendar sync calls (decision 195): the
 * token endpoint, the revoke endpoint and the Calendar API. It keeps calendars and
 * events the way Google does: a deleted event stays as a "cancelled" record whose id
 * can never be created again. Every call is logged without tokens, so a test can say
 * exactly what the sync sent. Nothing leaves the test.
 */
export type FakeEvent = {
  status: "confirmed" | "cancelled";
  body: Record<string, unknown>;
  revision: number;
};
export type Call = {
  kind:
    | "refresh"
    | "revoke"
    | "createCalendar"
    | "getCalendar"
    | "insert"
    | "get"
    | "replace"
    | "delete";
  calendar?: string;
  event?: string;
};
type Failure = {
  when: (call: Call) => boolean;
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
  times: number;
};

export type Profile = { sub: string; email: string; email_verified: boolean };
type CodeGrant = { profile: Profile; scopes: string[]; refreshToken?: string };
const segment = (value: object) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

export class FakeGoogle {
  readonly clientId = "synthetic-client.apps.googleusercontent.com";
  readonly clientSecret = "synthetic-google-client-secret";
  /** Refresh token → whether Google still honours it. */
  readonly tokens = new Map<string, "valid" | "revoked">();
  readonly calendars = new Map<
    string,
    { summary: string; timeZone: string; events: Map<string, FakeEvent> }
  >();
  readonly calls: Call[] = [];
  readonly revoked: string[] = [];
  /** Authorization codes of the sign-in, with what Google answers for each. */
  readonly codes = new Map<string, CodeGrant>();
  private failures: Failure[] = [];
  private accessTokens = new Map<string, string>();
  private counter = 0;
  private realFetch = globalThis.fetch;
  onCall?: (call: Call) => Promise<void>;
  loseResponse?: Call["kind"];

  install() {
    process.env.GOOGLE_CLIENT_ID = this.clientId;
    process.env.GOOGLE_CLIENT_SECRET = this.clientSecret;
    vi.stubGlobal(
      "fetch",
      async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        const answer = await this.handle(url, init);
        const last = this.calls.at(-1);
        if (
          answer &&
          this.loseResponse !== undefined &&
          last?.kind === this.loseResponse
        ) {
          this.loseResponse = undefined;
          throw new Error(
            "Synthetic response lost after provider accepted request"
          );
        }
        if (answer) return answer;
        if (url.startsWith("https://"))
          throw new Error(`Unexpected request outside the test: ${url}`);
        return this.realFetch(input, init);
      }
    );
  }
  /** The code Google redirects back with, for a sign-in that grants the given scopes. */
  issueCode(
    profile: Profile,
    options: { scopes?: string[]; refreshToken?: string } = {}
  ) {
    const code = `code-${++this.counter}`;
    this.codes.set(code, {
      profile,
      scopes: options.scopes ?? ["openid", "email", "profile"],
      refreshToken: options.refreshToken,
    });
    return code;
  }
  private idToken(profile: Profile) {
    const now = Math.floor(Date.now() / 1000);
    return [
      segment({ alg: "RS256", typ: "JWT", kid: "synthetic" }),
      segment({
        iss: "https://accounts.google.com",
        aud: this.clientId,
        iat: now,
        exp: now + 3600,
        name: "חשבון Google לבדיקה",
        ...profile,
      }),
      "synthetic-signature",
    ].join(".");
  }
  reset() {
    this.codes.clear();
    this.tokens.clear();
    this.calendars.clear();
    this.calls.length = 0;
    this.revoked.length = 0;
    this.failures = [];
    this.accessTokens.clear();
    this.onCall = undefined;
    this.loseResponse = undefined;
  }
  grant(refreshToken: string) {
    this.tokens.set(refreshToken, "valid");
  }
  /** The soldier revoked the permission in the Google account settings. */
  revoke(refreshToken: string) {
    this.tokens.set(refreshToken, "revoked");
  }
  /** The next matching calls fail with the given status. */
  fail(
    when: (call: Call) => boolean,
    status: number,
    options: {
      headers?: Record<string, string>;
      body?: unknown;
      times?: number;
    } = {}
  ) {
    this.failures.push({ when, status, times: options.times ?? 1, ...options });
  }
  count(kind: Call["kind"]) {
    return this.calls.filter((call) => call.kind === kind).length;
  }
  /** The only calendar a soldier has, and its live events. */
  calendar() {
    const [first] = [...this.calendars.entries()];
    return first ? { id: first[0], ...first[1] } : undefined;
  }
  live(calendarId?: string) {
    const calendar = calendarId
      ? this.calendars.get(calendarId)
      : this.calendar();
    return [...(calendar?.events.entries() ?? [])]
      .filter(([, event]) => event.status === "confirmed")
      .map(([id, event]) => ({ id, ...event.body }));
  }
  /** The soldier deleted the event in Google. */
  userDeletesEvent(calendarId: string, eventId: string) {
    const event = this.calendars.get(calendarId)?.events.get(eventId);
    if (event) {
      event.status = "cancelled";
      event.revision++;
    }
  }
  userDeletesCalendar(calendarId: string) {
    this.calendars.delete(calendarId);
  }

  private json(
    body: unknown,
    status = 200,
    headers: Record<string, string> = {}
  ) {
    return Response.json(body, { status, headers });
  }
  private failure(call: Call) {
    const index = this.failures.findIndex((item) => item.when(call));
    if (index < 0) return undefined;
    const item = this.failures[index];
    if (--item.times <= 0) this.failures.splice(index, 1);
    return this.json(
      item.body ?? { error: { errors: [{ reason: "synthetic" }] } },
      item.status,
      item.headers
    );
  }
  private authorized(init?: RequestInit) {
    const header = new Headers(init?.headers).get("authorization") ?? "";
    const refresh = this.accessTokens.get(header.replace(/^Bearer /, ""));
    return refresh !== undefined && this.tokens.get(refresh) === "valid";
  }

  private async handle(url: string, init?: RequestInit) {
    const method = (init?.method ?? "GET").toUpperCase();
    if (url === "https://oauth2.googleapis.com/token") {
      const form = new URLSearchParams(String(init?.body ?? ""));
      // The sign-in exchanges its code here; it is not one of the sync's calls.
      if (form.get("grant_type") === "authorization_code") {
        const grant = this.codes.get(form.get("code") ?? "");
        if (!grant) return this.json({ error: "invalid_grant" }, 400);
        const access = `access-${++this.counter}`;
        if (grant.refreshToken) {
          this.tokens.set(grant.refreshToken, "valid");
          this.accessTokens.set(access, grant.refreshToken);
        }
        return this.json({
          access_token: access,
          token_type: "Bearer",
          expires_in: 3600,
          scope: grant.scopes.join(" "),
          id_token: this.idToken(grant.profile),
          ...(grant.refreshToken && { refresh_token: grant.refreshToken }),
        });
      }
      this.calls.push({ kind: "refresh" });
      await this.onCall?.({ kind: "refresh" });
      const failed = this.failure({ kind: "refresh" });
      if (failed) return failed;
      if (
        form.get("client_id") !== this.clientId ||
        form.get("client_secret") !== this.clientSecret
      )
        return this.json({ error: "invalid_client" }, 401);
      const refresh = form.get("refresh_token") ?? "";
      if (
        form.get("grant_type") !== "refresh_token" ||
        this.tokens.get(refresh) !== "valid"
      )
        return this.json({ error: "invalid_grant" }, 400);
      const access = `access-${++this.counter}`;
      this.accessTokens.set(access, refresh);
      return this.json({
        access_token: access,
        expires_in: 3600,
        token_type: "Bearer",
      });
    }
    if (url === "https://oauth2.googleapis.com/revoke") {
      this.calls.push({ kind: "revoke" });
      const token = new URLSearchParams(String(init?.body ?? "")).get("token");
      if (token) {
        this.revoked.push(token);
        this.tokens.set(token, "revoked");
      }
      return this.json({});
    }
    const api = /^https:\/\/www\.googleapis\.com\/calendar\/v3\/(.*)$/.exec(
      url
    );
    if (!api) return undefined;
    const [path] = api[1].split("?");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const calendarMatch =
      /^calendars\/([^/]+)(?:\/events(?:\/([^/]+))?)?$/.exec(path);
    const calendarId = calendarMatch && decodeURIComponent(calendarMatch[1]);
    const eventId = calendarMatch?.[2] && decodeURIComponent(calendarMatch[2]);
    const kind: Call["kind"] | undefined =
      path === "calendars" && method === "POST"
        ? "createCalendar"
        : calendarId &&
            !eventId &&
            method === "GET" &&
            !path.endsWith("/events")
          ? "getCalendar"
          : eventId
            ? method === "GET"
              ? "get"
              : method === "PUT"
                ? "replace"
                : method === "DELETE"
                  ? "delete"
                  : undefined
            : method === "POST" && path.endsWith("/events")
              ? "insert"
              : undefined;
    if (!kind) return this.json({ error: { code: 400 } }, 400);
    const call: Call = {
      kind,
      calendar: calendarId || undefined,
      event: eventId || undefined,
    };
    this.calls.push(call);
    // Permission is checked when the provider accepts a request. A revocation while
    // it is already being processed need not cancel that in-flight mutation.
    const authorized = this.authorized(init);
    await this.onCall?.(call);
    const failed = this.failure(call);
    if (failed) return failed;
    if (!authorized)
      return this.json(
        { error: { code: 401, status: "UNAUTHENTICATED" } },
        401
      );
    if (kind === "createCalendar") {
      const id = `calendar-${++this.counter}@group.calendar.google.com`;
      this.calendars.set(id, {
        summary: body.summary,
        timeZone: body.timeZone,
        events: new Map(),
      });
      return this.json({ id });
    }
    const calendar = calendarId ? this.calendars.get(calendarId) : undefined;
    if (!calendar)
      return this.json(
        { error: { code: 404, errors: [{ reason: "notFound" }] } },
        404
      );
    if (kind === "getCalendar")
      return this.json({
        id: calendarId,
        summary: calendar.summary,
        timeZone: calendar.timeZone,
      });
    if (kind === "insert") {
      if (calendar.events.has(body.id))
        return this.json({ error: { code: 409 } }, 409);
      calendar.events.set(body.id, { status: "confirmed", body, revision: 1 });
      return this.json({ id: body.id });
    }
    const event = calendar.events.get(eventId as string);
    if (!event)
      return this.json(
        { error: { code: 404, errors: [{ reason: "notFound" }] } },
        404
      );
    if (kind === "get")
      return this.json({
        id: eventId,
        status: event.status,
        etag: `"${event.revision}"`,
      });
    const ifMatch = new Headers(init?.headers).get("if-match");
    if (ifMatch && ifMatch !== `"${event.revision}"`)
      return this.json({ error: { code: 412 } }, 412);
    if (event.status === "cancelled")
      return this.json({ error: { code: 404 } }, 404);
    if (kind === "replace") {
      event.body = body;
      event.revision++;
      return this.json({ id: eventId });
    }
    event.status = "cancelled";
    event.revision++;
    return new Response(null, { status: 204 });
  }
}
