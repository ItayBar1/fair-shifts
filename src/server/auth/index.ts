import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import * as tables from "../auth-schema";
import { accountAvailable, type Actor, useRecoveryCode } from "./accounts";
import { sessionLifetime, secret, type Role } from "./policy";
import { requestCode, verifyCode } from "./otp";
import { AppError } from "../errors";

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

function configureAuth() {
  return betterAuth({
    secret: secret("BETTER_AUTH_SECRET"),
    baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
    database: drizzleAdapter(db, { provider: "pg", schema: tables }),
    emailAndPassword: { enabled: false },
    socialProviders:
      process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
        ? {
            google: {
              clientId: process.env.GOOGLE_CLIENT_ID,
              clientSecret: process.env.GOOGLE_CLIENT_SECRET,
              disableSignUp: true,
            },
          }
        : {},
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
          },
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
              // Epochs start at 1; 0 is the default of a provider sign-in, which proves nothing.
              const proofEpoch = (
                value as typeof value & { securityEpoch?: number }
              ).securityEpoch;
              if (proofEpoch && proofEpoch !== person.securityEpoch)
                return false;
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
  return (instance ??= configureAuth());
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
