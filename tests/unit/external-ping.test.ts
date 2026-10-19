import { afterEach, describe, expect, it } from "vitest";
import {
  WORKER_PING_INTERVAL_MS,
  externalPings,
} from "../../src/server/operations/external-ping";

const saved = {
  worker: process.env.HEALTHCHECK_PING_URL,
  backup: process.env.HEALTHCHECK_BACKUP_URL,
};
afterEach(() => {
  for (const [name, value] of [
    ["HEALTHCHECK_PING_URL", saved.worker],
    ["HEALTHCHECK_BACKUP_URL", saved.backup],
  ] as const)
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
});

describe("external monitor pings (decision 236)", () => {
  it("pings the worker address at most every five minutes, with nothing in it", async () => {
    process.env.HEALTHCHECK_PING_URL = "https://monitor.example.invalid/worker";
    const calls: { url: string; init?: RequestInit }[] = [];
    let now = 1_000_000;
    const pings = externalPings(
      (async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        return new Response("OK");
      }) as typeof fetch,
      () => now
    );
    expect(await pings.worker()).toBe(true);
    now += WORKER_PING_INTERVAL_MS - 1;
    expect(await pings.worker()).toBe(false);
    now += 1;
    expect(await pings.worker()).toBe(true);
    expect(calls.map((call) => call.url)).toEqual([
      "https://monitor.example.invalid/worker",
      "https://monitor.example.invalid/worker",
    ]);
    expect(calls[0]!.init).toMatchObject({ method: "GET" });
    expect(calls[0]!.init?.body).toBeUndefined();
  });
  it("is off without an address, and a failed ping only returns false", async () => {
    delete process.env.HEALTHCHECK_PING_URL;
    process.env.HEALTHCHECK_BACKUP_URL =
      "https://monitor.example.invalid/backup";
    let called = 0;
    const pings = externalPings((async () => {
      called++;
      throw new Error("network down");
    }) as typeof fetch);
    expect(await pings.worker()).toBe(false);
    expect(called).toBe(0);
    expect(await pings.backup()).toBe(false);
    expect(called).toBe(1);
  });
});
