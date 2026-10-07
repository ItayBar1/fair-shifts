import type { CalendarEventBody } from "../../domain/calendar-sync";

/**
 * The calls to Google for the calendar sync (decision 195): a fresh access token from
 * the stored refresh token, the calendar of the application, and its events. The
 * messages carry only a category: Google's answers can quote addresses and tokens,
 * so they are never kept, logged or shown.
 */
export type GoogleErrorKind =
  /** The permission was revoked, expired or never held: the soldier must grant it again. */
  | "auth"
  /** Too many requests, or a quota: try again later. */
  | "rate"
  /** The network or Google failed: try again later. */
  | "transient"
  /** The calendar or event does not exist (any more). */
  | "missing"
  /** The event id already exists. */
  | "conflict"
  /** The event changed after it was read. */
  | "changed"
  /** Google refuses this request as it is; repeating it does not help. */
  | "rejected"
  /** The application's own setup (client, API switched off) is wrong. */
  | "configuration";

export class GoogleError extends Error {
  constructor(
    readonly kind: GoogleErrorKind,
    readonly retryAfterMs = 0
  ) {
    super(`calendar_${kind}`);
    this.name = "GoogleError";
  }
}

const API = "https://www.googleapis.com/calendar/v3";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const TIMEOUT_MS = 15_000;

const RATE_REASONS = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "quotaExceeded",
  "calendarUsageLimitsExceeded",
  "dailyLimitExceeded",
]);
const CONFIGURATION_REASONS = new Set([
  "accessNotConfigured",
  "SERVICE_DISABLED",
  "keyInvalid",
  "ipRefererBlocked",
]);

function retryAfter(response: Response) {
  const header = response.headers.get("retry-after");
  if (!header) return 0;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds) * 1000;
  const at = Date.parse(header);
  return Number.isNaN(at) ? 0 : Math.max(0, at - Date.now());
}

async function reasonOf(response: Response) {
  try {
    const body = (await response.json()) as {
      error?: { errors?: { reason?: string }[]; status?: string };
    };
    return body.error?.errors?.[0]?.reason ?? body.error?.status;
  } catch {
    return undefined;
  }
}

async function fail(response: Response): Promise<never> {
  const status = response.status;
  if (status === 401) throw new GoogleError("auth");
  if (status === 404 || status === 410) throw new GoogleError("missing");
  if (status === 409) throw new GoogleError("conflict");
  if (status === 412) throw new GoogleError("changed");
  if (status === 429) throw new GoogleError("rate", retryAfter(response));
  if (status === 403) {
    const reason = await reasonOf(response);
    if (reason && RATE_REASONS.has(reason))
      throw new GoogleError("rate", retryAfter(response));
    if (reason && CONFIGURATION_REASONS.has(reason))
      throw new GoogleError("configuration");
    // A refusal for any other reason: the permission is not there for this calendar.
    throw new GoogleError("auth");
  }
  if (status >= 500) throw new GoogleError("transient", retryAfter(response));
  throw new GoogleError("rejected");
}

async function send(url: string, init: RequestInit) {
  try {
    return await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new GoogleError("transient");
  }
}

/** A new access token from the refresh token. `invalid_grant` means the permission is gone. */
export async function refreshAccessToken(refreshToken: string) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new GoogleError("configuration");
  const response = await send(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (response.ok) {
    const body = (await response.json().catch(() => null)) as {
      access_token?: string;
    } | null;
    if (!body?.access_token) throw new GoogleError("transient");
    return body.access_token;
  }
  if (response.status === 400 || response.status === 401) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    if (body?.error === "invalid_client")
      throw new GoogleError("configuration");
    if (body?.error === "invalid_grant") throw new GoogleError("auth");
    throw new GoogleError("rejected");
  }
  if (response.status === 429)
    throw new GoogleError("rate", retryAfter(response));
  throw new GoogleError("transient", retryAfter(response));
}

/** Best effort: a token that is already invalid or unreachable is simply left. */
export async function revokeToken(token: string) {
  try {
    await send(REVOKE_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    });
  } catch {
    /* Revocation is a courtesy; the token was already deleted here. */
  }
}

function headers(accessToken: string) {
  return {
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
  };
}
const calendarPath = (calendarId: string) =>
  `${API}/calendars/${encodeURIComponent(calendarId)}`;
const eventPath = (calendarId: string, eventId: string) =>
  `${calendarPath(calendarId)}/events/${encodeURIComponent(eventId)}`;

export async function createCalendar(
  accessToken: string,
  summary: string,
  timeZone: string
) {
  const response = await send(`${API}/calendars`, {
    method: "POST",
    headers: headers(accessToken),
    body: JSON.stringify({ summary, timeZone }),
  });
  if (!response.ok) return fail(response);
  const body = (await response.json().catch(() => null)) as {
    id?: string;
  } | null;
  if (!body?.id) throw new GoogleError("transient");
  return body.id;
}

/** Distinguishes a deleted calendar from one missing event, using the narrow app scope. */
export async function calendarExists(accessToken: string, calendarId: string) {
  return Boolean(await calendarMetadata(accessToken, calendarId));
}

export async function calendarMetadata(
  accessToken: string,
  calendarId: string
) {
  const response = await send(calendarPath(calendarId), {
    method: "GET",
    headers: headers(accessToken),
  });
  if (response.status === 404 || response.status === 410) return null;
  if (!response.ok) return fail(response);
  const body = (await response.json().catch(() => null)) as {
    id?: unknown;
    summary?: unknown;
    timeZone?: unknown;
  } | null;
  if (
    typeof body?.id !== "string" ||
    typeof body.summary !== "string" ||
    typeof body.timeZone !== "string"
  )
    throw new GoogleError("transient");
  return { id: body.id, summary: body.summary, timeZone: body.timeZone };
}

/** Creates the event under the given id; `conflict` means it already exists. */
export async function insertEvent(
  accessToken: string,
  calendarId: string,
  id: string,
  body: CalendarEventBody
) {
  const response = await send(
    `${calendarPath(calendarId)}/events?sendUpdates=none`,
    {
      method: "POST",
      headers: headers(accessToken),
      body: JSON.stringify({ id, ...body }),
    }
  );
  if (!response.ok) return fail(response);
}

/** The event as Google holds it, or null when it is gone (404 or 410). */
export async function readEvent(
  accessToken: string,
  calendarId: string,
  id: string
) {
  const response = await send(eventPath(calendarId, id), {
    method: "GET",
    headers: headers(accessToken),
  });
  if (response.status === 404 || response.status === 410) return null;
  if (!response.ok) return fail(response);
  const body = (await response.json().catch(() => null)) as {
    status?: string;
    etag?: string;
  } | null;
  if (!body?.etag) throw new GoogleError("transient");
  return { status: body.status ?? "confirmed", etag: body.etag };
}

/** Replaces the event with the given body, so a field the duty no longer has is cleared. */
export async function replaceEvent(
  accessToken: string,
  calendarId: string,
  id: string,
  body: CalendarEventBody,
  etag: string
) {
  const response = await send(`${eventPath(calendarId, id)}?sendUpdates=none`, {
    method: "PUT",
    headers: { ...headers(accessToken), "if-match": etag },
    body: JSON.stringify({ id, ...body }),
  });
  if (!response.ok) return fail(response);
}

/** An event that is already gone counts as removed. */
export async function removeEvent(
  accessToken: string,
  calendarId: string,
  id: string
) {
  const response = await send(`${eventPath(calendarId, id)}?sendUpdates=none`, {
    method: "DELETE",
    headers: headers(accessToken),
  });
  if (response.ok || response.status === 404 || response.status === 410) return;
  return fail(response);
}
