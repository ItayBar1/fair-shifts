import { Client } from "pg";
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../db";

/**
 * Codes go out at once instead of on the next minute's maintenance (decision
 * 188). enqueueEmail notifies this channel inside its transaction, so
 * PostgreSQL delivers the signal only once the code is committed, and never
 * for a rolled-back one. The worker listens and drains the same outbox, with
 * the same quota, priority, retries and relevance checks.
 */
export const MAIL_CHANNEL = "fair_shifts_mail_due";

export async function signalMail(tx: DbTransaction) {
  await tx.execute(sql`select pg_notify(${MAIL_CHANNEL}, '')`);
}

/**
 * Runs `work` once at a time. A call during a run asks for one more run after
 * it, so a signal is never lost and a burst of signals costs one extra run.
 */
export function singleFlight(work: () => Promise<void>) {
  let running: Promise<void> | undefined;
  let again = false;
  const run = () => {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          await work();
        } while (again);
      } finally {
        running = undefined;
      }
    })();
    return running;
  };
  return Object.assign(run, {
    /** Resolves when no run is in progress; failures are the caller's. */
    settled: () => (running ?? Promise.resolve()).catch(() => undefined),
  });
}

type ListenOptions = {
  connectionString?: string;
  retryMs?: number;
  onListening?: () => void;
};
/**
 * Listens on its own connection and reconnects after a loss. Every new
 * connection also fires one signal, for mail committed while it was down; the
 * minute's maintenance remains the fallback for anything else.
 */
export function listenForMail(
  onSignal: () => void,
  {
    connectionString = process.env.DATABASE_URL,
    retryMs = 5_000,
    onListening,
  }: ListenOptions = {}
) {
  let client: Client | undefined;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const retry = (dead: Client, error?: Error) => {
    if (stopped || timer || (client && client !== dead)) return;
    // English: read in the worker's container log on the server (decision 187).
    if (error) console.error("Mail signal connection lost", error.name);
    client = undefined;
    dead.end().catch(() => undefined);
    timer = setTimeout(() => {
      timer = undefined;
      void connect();
    }, retryMs);
  };
  const connect = async () => {
    if (stopped) return;
    const next = new Client({ connectionString });
    next.on("notification", (message) => {
      if (message.channel === MAIL_CHANNEL) onSignal();
    });
    next.on("error", (error) => retry(next, error));
    next.on("end", () => retry(next));
    try {
      await next.connect();
      await next.query(`listen ${MAIL_CHANNEL}`);
    } catch (error) {
      retry(next, error as Error);
      return;
    }
    if (stopped) {
      await next.end().catch(() => undefined);
      return;
    }
    client = next;
    onListening?.();
    onSignal();
  };
  void connect();
  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await client?.end().catch(() => undefined);
    },
  };
}
