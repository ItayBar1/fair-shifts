import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { eq } from "drizzle-orm";
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
      accountLinking: { enabled: true, trustedProviders: ["google"] },
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
              const proofEpoch = (
                value as typeof value & { securityEpoch?: number }
              ).securityEpoch;
              if (proofEpoch && proofEpoch !== person.securityEpoch)
                return false;
              await tx
                .update(tables.user)
                .set({ failedAttempts: 0 })
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
              const session = await ctx.context.internalAdapter.createSession(
                proof.user.id,
                false,
                { securityEpoch: proof.epoch }
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
    population: person.population ?? undefined,
    securityEpoch: person.securityEpoch,
  };
}
