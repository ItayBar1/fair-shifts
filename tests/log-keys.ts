import { generateKeyPairSync } from "node:crypto";
import {
  nextEntry as signedEntry,
  parseLog as verifiedLog,
} from "../src/domain/deletion-log";
const pair = generateKeyPairSync("ed25519");
export const testLogKeys = {
  signer: { keyId: "synthetic-test", privateKey: pair.privateKey },
  publicKeys: { "synthetic-test": pair.publicKey },
};
export const nextEntry = (
  ...args: [
    Parameters<typeof signedEntry>[0],
    Parameters<typeof signedEntry>[1],
  ]
) => signedEntry(...args, testLogKeys.signer);
export const parseLog = (text: string) =>
  verifiedLog(text, testLogKeys.publicKeys);
