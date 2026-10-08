import { randomUUID, generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { openSecret, sealSecret } from "../../src/server/secrets";
import {
  entryHash,
  nextEntry,
  parseLog,
  serializeEntry,
} from "../../src/domain/deletion-log";
beforeEach(() => {
  process.env.MAIL_ENCRYPTION_KEY = "41".repeat(32);
});
describe("strict authenticated secret format", () => {
  const context = { purpose: "mail-code" as const, recordId: randomUUID() };
  it("authenticates purpose and record, so copying a ciphertext cannot move a code or a Calendar token", () => {
    const value = sealSecret("synthetic-secret", context);
    expect(openSecret(value, context)).toBe("synthetic-secret");
    expect(() =>
      openSecret(value, { ...context, recordId: randomUUID() })
    ).toThrow();
    expect(() =>
      openSecret(value, { ...context, purpose: "calendar-refresh" })
    ).toThrow();
    expect(sealSecret("synthetic-secret", context)).not.toBe(value);
  });
  it("rejects short tags, noncanonical encoding, extra fields, wrong nonce and legacy format", () => {
    const value = sealSecret("synthetic-secret", context),
      parts = value.split(".");
    for (const bad of [
      parts.slice(1).join("."),
      value + ".extra",
      value.replace("v2", "v3"),
      [parts[0], parts[1], parts[2].slice(0, 8), parts[3]].join("."),
      [parts[0], parts[1] + "=", parts[2], parts[3]].join("."),
      [parts[0], "AA", parts[2], parts[3]].join("."),
    ])
      expect(() => openSecret(bad, context)).toThrow();
  });
  it("rejects changed authenticated ciphertext", () => {
    const parts = sealSecret("synthetic-secret", context).split(".");
    const bytes = Buffer.from(parts[3], "base64url");
    bytes[0] ^= 1;
    parts[3] = bytes.toString("base64url");
    expect(() => openSecret(parts.join("."), context)).toThrow();
  });
});
describe("signed deletion chain", () => {
  const pair = generateKeyPairSync("ed25519"),
    rotated = generateKeyPairSync("ed25519");
  const signer = { keyId: "first", privateKey: pair.privateKey };
  const keys = { first: pair.publicKey, second: rotated.publicKey };
  const input = {
    id: randomUUID(),
    soldierId: randomUUID(),
    at: new Date().toISOString(),
  };
  it("verifies with public keys only, including an explicit key rotation", () => {
    const first = nextEntry(undefined, input, signer);
    const second = nextEntry(
      first,
      { ...input, id: randomUUID() },
      { keyId: "second", privateKey: rotated.privateKey }
    );
    expect(
      parseLog([first, second].map(serializeEntry).join(""), keys).problems
    ).toEqual([]);
    expect(parseLog(serializeEntry(first), {}).problems[0].code).toBe(
      "signature"
    );
    expect(
      parseLog(serializeEntry(first), { first: rotated.publicKey }).problems[0]
        .code
    ).toBe("signature");
  });
  it("rejects an attacker who changes a deletion and recomputes every hash", () => {
    const real = nextEntry(undefined, input, signer),
      forged = { ...real, soldierId: randomUUID() };
    forged.hash = entryHash(forged);
    expect(parseLog(serializeEntry(forged), keys).problems).toEqual([
      { code: "signature", line: 1 },
    ]);
  });
  it("rejects unsigned old lines and malformed signatures outside the conversion tool", () => {
    const real = nextEntry(undefined, input, signer);
    const unsigned = {
      v: 1,
      seq: real.seq,
      id: real.id,
      soldierId: real.soldierId,
      at: real.at,
      prev: real.prev,
      hash: real.hash,
    };
    expect(
      parseLog(JSON.stringify({ ...unsigned, v: 1 }) + "\n", keys).problems[0]
        .code
    ).toBe("malformed");
    expect(
      parseLog(serializeEntry({ ...real, signature: "AA" }), keys).problems[0]
        .code
    ).toBe("malformed");
  });
});
