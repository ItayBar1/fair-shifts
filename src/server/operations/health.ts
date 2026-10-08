import { eq, sql } from "drizzle-orm";
import { db, type DbTransaction } from "../db";
import { operationsState } from "../auth-schema";

// The worker runs every minute; three missed beats mark it as delayed.
export const WORKER_STALE_MS = 180_000;
const HEARTBEAT_KEY = "worker";

export const appVersion = () => process.env.APP_VERSION || "development";

/** Public readiness reveals no version, heartbeat or worker state. */
export async function readPublicHealth(executor: Executor = db) {
  try {
    await executor.execute(sql`select 1`);
    return { status: "ok" as const };
  } catch {
    console.error("Public health check failed");
    return { status: "unavailable" as const };
  }
}

type Executor = typeof db | DbTransaction;
export type WorkerHealth = {
  status: "ok" | "paused" | "stale" | "missing";
  lastBeatAt?: string;
  lastSuccessAt?: string;
  version?: string;
  sameVersion: boolean;
};
export type SystemHealth = {
  status: "ok" | "degraded" | "unavailable";
  version: string;
  checkedAt: string;
  database: "ok" | "unavailable";
  worker: WorkerHealth;
};

// Merges into the existing row so a paused beat keeps the last successful run.
export async function recordWorkerHeartbeat(
  tx: Executor,
  beat: { now: Date; paused: boolean; credited?: number }
) {
  const data: Record<string, unknown> = {
    lastBeatAt: beat.now.toISOString(),
    version: appVersion(),
    paused: beat.paused,
  };
  if (!beat.paused) {
    data.lastSuccessAt = beat.now.toISOString();
    data.credited = beat.credited ?? 0;
  }
  await tx
    .insert(operationsState)
    .values({ key: HEARTBEAT_KEY, data, updatedAt: beat.now })
    .onConflictDoUpdate({
      target: operationsState.key,
      set: {
        data: sql`${operationsState.data} || excluded.data`,
        updatedAt: beat.now,
      },
    });
}

const text = (value: unknown) =>
  typeof value === "string" && value ? value : undefined;

export function workerHealth(
  data: Record<string, unknown> | undefined,
  now: Date
): WorkerHealth {
  // Rows written before heartbeats existed only carry lastSuccessAt.
  const lastBeatAt = text(data?.lastBeatAt) ?? text(data?.lastSuccessAt);
  const version = text(data?.version);
  const base = {
    lastBeatAt,
    lastSuccessAt: text(data?.lastSuccessAt),
    version,
    sameVersion: version === appVersion(),
  };
  if (!lastBeatAt) return { ...base, status: "missing" };
  if (now.getTime() - new Date(lastBeatAt).getTime() > WORKER_STALE_MS)
    return { ...base, status: "stale" };
  return { ...base, status: data?.paused === true ? "paused" : "ok" };
}

// Operational status only: no accounts, soldiers, contacts or mail content.
export async function readHealth(
  executor: Executor = db,
  now = new Date()
): Promise<SystemHealth> {
  const unavailable: SystemHealth = {
    status: "unavailable",
    version: appVersion(),
    checkedAt: now.toISOString(),
    database: "unavailable",
    worker: { status: "missing", sameVersion: false },
  };
  try {
    const [row] = await executor
      .select({ data: operationsState.data })
      .from(operationsState)
      .where(eq(operationsState.key, HEARTBEAT_KEY));
    const worker = workerHealth(row?.data, now);
    return {
      status: worker.status === "ok" && worker.sameVersion ? "ok" : "degraded",
      version: appVersion(),
      checkedAt: now.toISOString(),
      database: "ok",
      worker,
    };
  } catch (error) {
    console.error(
      "Health check failed",
      error instanceof Error ? error.name : "unknown"
    );
    return unavailable;
  }
}
