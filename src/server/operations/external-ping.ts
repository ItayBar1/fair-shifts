/**
 * Pings to an external monitor (decision 236). The site's own alerts cannot
 * report a stopped server or worker, so the worker tells an outside service it
 * is alive, and that a backup was verified; the service mails the technical
 * admin when a ping stops coming. A ping carries no unit data. An empty URL
 * turns it off, and a failed ping never affects the worker.
 */
export const WORKER_PING_INTERVAL_MS = 5 * 60_000;
const PING_TIMEOUT_MS = 10_000;

export function externalPings(
  fetcher: typeof fetch = fetch,
  clock: () => number = Date.now
) {
  let lastWorkerPing = -Infinity;
  async function ping(name: string, url: string | undefined) {
    if (!url) return false;
    try {
      const response = await fetcher(url, {
        method: "GET",
        signal: AbortSignal.timeout(PING_TIMEOUT_MS),
      });
      if (!response.ok)
        console.error(`External ${name} ping failed`, response.status);
      return response.ok;
    } catch (error) {
      console.error(
        `External ${name} ping failed`,
        error instanceof Error ? error.name : "unknown"
      );
      return false;
    }
  }
  return {
    /** After a maintenance cycle that succeeded; at most every five minutes. */
    async worker() {
      if (clock() - lastWorkerPing < WORKER_PING_INTERVAL_MS) return false;
      lastWorkerPing = clock();
      return ping("worker", process.env.HEALTHCHECK_PING_URL);
    },
    /** After a backup was verified. */
    backup() {
      return ping("backup", process.env.HEALTHCHECK_BACKUP_URL);
    },
  };
}
