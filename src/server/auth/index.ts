import { AsyncLocalStorage } from "node:async_hooks";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { google } from "better-auth/social-providers";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import * as tables from "../auth-schema";
import { accountAvailable, type Actor, useRecoveryCode } from "./accounts";
import { sessionLifetime, secret, type Role } from "./policy";
import { requestCode, verifyCode } from "./otp";
import { AppError } from "../errors";
import { CALENDAR_SCOPE } from "../../domain/calendar-sync";
import { calendarSyncEnabled } from "../calendar/config";
import { recordGoogleGrant } from "../calendar/link";

type GoogleProof = {
  userId: string;
  epoch: number;
  subject: string;
  scopes?: readonly string[] | null;
  refreshToken?: string | null;
};
// The proof and grant belong to one callback, never to another concurrent login.
const googleAttempt = new AsyncLocalStorage<{ proof?: GoogleProof }>();

async function authOperation<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof AppError)
      throw new APIError(
        error.status === 429
          ? "TOO_MANY_REQUESTS"
          : error.status === 403
            ? "FORBIDDEN"
            : error.status === 503
              ? "SERVICE_UNAVAILABLE"
              : "UNAUTHORIZED",
        { code: error.code, message: error.message }
      );
    throw error;
  }
}

type SessionIssuer<T> = {
  createSession(
    userId: string,
    dontRememberMe: boolean,
    override: { securityEpoch: number },
    overrideAll: boolean
  ): Promise<T>;
};
/**
 * Opens a session only while the epoch proven by the code is still current.
 * Better Auth spreads additional-field defaults over a partial override, which
 * would reset the proof to 0 and let a session outlive a revocation that
 * committed between the code check and this call; overrideAll keeps it.
 */
export function createProvenSession<T>(
  adapter: SessionIssuer<T>,
  proof: { user: { id: string }; epoch: number }
) {
  return adapter.createSession(
    proof.user.id,
    false,
    { securityEpoch: proof.epoch },
    true
  );
}

/**
 * Google as the sign-in provider. With the calendar sync on (decision 195) every
 * request also asks for the one calendar permission and for a refresh token, and each
 * answer records what Google granted. Better Auth keeps neither access nor refresh
 * token (see the account hooks below): the sync holds its own sealed copy.
 */
export function googleProvider() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return {};
  const base = {
    clientId,
    clientSecret,
    disableSignUp: true,
    includeGrantedScopes: false,
  };
  const standard = google(base);
  return {
    google: {
      ...base,
      ...(calendarSyncEnabled() && {
        scope: [CALENDAR_SCOPE],
        accessType: "offline" as const,
      }),
      // Read the identity through the provider before using it. Keep the actual
      // response scopes: Better Auth deliberately omits scope on repeat sign-in.
      getUserInfo: async (
        token: Parameters<typeof standard.getUserInfo>[0]
      ) => {
        const result = await standard.getUserInfo(token);
        const identity = result?.user;
        // In 1.7.6 Google intentionally leaves user.id unset; accountSubject
        // resolves its stable key from the provider profile's sub instead.
        const subject = result?.data?.sub;
        const attempt = googleAttempt.getStore();
        if (identity && typeof subject === "string" && attempt) {
          const [linked] = await db
            .select({ userId: tables.account.userId })
            .from(tables.account)
            .where(
              and(
                eq(tables.account.providerId, "google"),
                eq(tables.account.accountId, subject)
              )
            );
          const [person] = await db
            .select()
            .from(tables.user)
            .where(
              linked
                ? eq(tables.user.id, linked.userId)
                : eq(tables.user.email, String(identity.email).toLowerCase())
            );
          if (person && (linked || identity.emailVerified))
            attempt.proof = {
              userId: person.id,
              epoch: person.securityEpoch,
              subject,
              scopes: token.scopes,
              refreshToken: token.refreshToken,
            };
        }
        return result;
      },
    },
  };
}

/**
 * Tokens of the provider are never kept in the account row (decision 195). A hook's
 * result is merged into the data, so a token is cleared by setting it to null.
 */
const providerTokens = [
  "accessToken",
  "refreshToken",
  "accessTokenExpiresAt",
  "refreshTokenExpiresAt",
  "idToken",
] as const;
function withoutTokens<T extends Record<string, unknown>>(value: T): T {
  return {
    ...value,
    ...Object.fromEntries(providerTokens.map((key) => [key, null])),
  };
}

function configureAuth() {
  return betterAuth({
    secret: secret("BETTER_AUTH_SECRET"),
    baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
    database: drizzleAdapter(db, { provider: "pg", schema: tables }),
    emailAndPassword: { enabled: false },
    socialProviders: googleProvider(),
    logger: {
      level: "warn",
      // Library/provider exceptions may include OAuth request bodies or tokens.
      // Keep the operational signal, without logging their untrusted content.
      log: (level) => {
        if (level === "error") console.error("Authentication operation failed");
        else if (level === "warn") console.warn("Authentication warning");
      },
    },
    account: {
      // The invitation address is the local proof, so an invited person may
      // start with Google before ever using a code. Google is not trusted by
      // name: the first link needs Google's own email_verified claim.
      accountLinking: { enabled: true, requireLocalEmailVerified: false },
    },
    session: {
      expiresIn: 7 * 86400,
      disableSessionRefresh: true,
      cookieCache: { enabled: false },
      additionalFields: {
        securityEpoch: {
          type: "number",
          required: true,
          input: false,
          defaultValue: 0,
        },
      },
    },
    user: {
      additionalFields: {
        role: { type: "string", input: false },
        soldierId: { type: "string", input: false, required: false },
      },
    },
    databaseHooks: {
      user: { create: { before: async () => false } },
      // Sign-in is bound to the provider's stable sub. Another Google account
      // that shows the same address never becomes a second link. The unique
      // index auth_account_user_provider settles a race between two; this
      // check keeps the usual refusal from reaching a failed insert, whose
      // log would carry the provider tokens.
      account: {
        create: {
          before: async (value) => {
            const proof = googleAttempt.getStore()?.proof;
            if (value.providerId === "google") {
              const [person] = await db
                .select()
                .from(tables.user)
                .where(eq(tables.user.id, value.userId));
              if (
                !proof ||
                proof.userId !== value.userId ||
                proof.subject !== value.accountId ||
                !person ||
                person.securityEpoch !== proof.epoch ||
                !(await accountAvailable(person))
              )
                return false;
            }
            const [linked] = await db
              .select({ id: tables.account.id })
              .from(tables.account)
              .where(
                and(
                  eq(tables.account.userId, value.userId),
                  eq(tables.account.providerId, value.providerId)
                )
              );
            if (linked) return false;
            return { data: withoutTokens(value) };
          },
        },
        update: {
          before: async (value) => ({ data: withoutTokens(value) }),
        },
      },
      session: {
        create: {
          before: async (value) =>
            db.transaction(async (tx) => {
              const [person] = await tx
                .select()
                .from(tables.user)
                .where(eq(tables.user.id, value.userId))
                .for("update");
              if (!person || !(await accountAvailable(person, tx)))
                return false;
              const googleProof = googleAttempt.getStore()?.proof;
              if (
                googleProof &&
                (googleProof.userId !== person.id ||
                  googleProof.epoch !== person.securityEpoch)
              )
                return false;
              // Epochs start at 1; 0 is the default of a provider sign-in, which proves nothing.
              const proofEpoch = (
                value as typeof value & { securityEpoch?: number }
              ).securityEpoch;
              if (proofEpoch && proofEpoch !== person.securityEpoch)
                return false;
              if (googleProof)
                await recordGoogleGrant(person.id, googleProof, tx);
              await tx
                .update(tables.user)
                .set({
                  failedAttempts: 0,
                  firstSignInAt: person.firstSignInAt ?? new Date(),
                })
                .where(eq(tables.user.id, person.id));
              return {
                data: {
                  ...value,
                  securityEpoch: proofEpoch || person.securityEpoch,
                  expiresAt: new Date(
                    Date.now() + sessionLifetime(person.role as Role)
                  ),
                },
              };
            }),
        },
      },
    },
    plugins: [
      {
        id: "unit-email-code",
        endpoints: {
          requestUnitCode: createAuthEndpoint(
            "/request-code",
            { method: "POST", body: z.object({ email: z.email() }) },
            async (ctx) =>
              ctx.json(await authOperation(() => requestCode(ctx.body.email)))
          ),
          verifyUnitCode: createAuthEndpoint(
            "/verify-code",
            {
              method: "POST",
              body: z.object({
                email: z.email(),
                code: z.string().min(1).max(100),
              }),
            },
            async (ctx) => {
              const proof = await authOperation(() =>
                verifyCode(ctx.body.email, ctx.body.code)
              );
              const session = await createProvenSession(
                ctx.context.internalAdapter,
                proof
              );
              if (!session)
                throw new AppError("unauthorized", "יש להתחבר מחדש", 401);
              await setSessionCookie(ctx, { session, user: proof.user });
              return ctx.json({ success: true });
            }
          ),
          recoverUnitAccount: createAuthEndpoint(
            "/recovery",
            {
              method: "POST",
              body: z.object({
                email: z.email(),
                code: z.string().min(1).max(200),
              }),
            },
            async (ctx) =>
              ctx.json(
                await authOperation(() =>
                  useRecoveryCode(ctx.body.email, ctx.body.code)
                )
              )
          ),
        },
      },
    ],
  });
}
let instance: ReturnType<typeof configureAuth> | undefined;
export function getAuth() {
  if (!instance) {
    instance = configureAuth();
    const handler = instance.handler;
    instance.handler = async (request) => {
      if (
        request.method === "POST" &&
        new URL(request.url).pathname.endsWith("/sign-in/social")
      ) {
        const payload = (await request
          .clone()
          .json()
          .catch(() => null)) as Record<string, unknown> | null;
        if (payload?.provider === "google") {
          const parameters = payload.additionalParams;
          const prompt =
            parameters &&
            typeof parameters === "object" &&
            "prompt" in parameters
              ? parameters.prompt
              : undefined;
          // The server owns OAuth scopes and offline access. A direct caller
          // cannot broaden access with scopes or authorization parameters.
          request = new Request(request, {
            body: JSON.stringify({
              ...payload,
              scopes: [],
              additionalParams: typeof prompt === "string" ? { prompt } : {},
            }),
          });
        }
      }
      return googleAttempt.run({}, () => handler(request));
    };
  }
  return instance;
}
export async function getActor(headers: Headers): Promise<Actor | null> {
  const authSession = await getAuth().api.getSession({ headers });
  if (!authSession) return null;
  const [person] = await db
    .select()
    .from(tables.user)
    .where(eq(tables.user.id, authSession.user.id));
  if (
    !person ||
    authSession.session.securityEpoch !== person.securityEpoch ||
    !(await accountAvailable(person))
  )
    return null;
  return {
    id: person.id,
    name: person.name,
    role: person.role as Role,
    soldierId: person.soldierId ?? undefined,
    securityEpoch: person.securityEpoch,
  };
}
