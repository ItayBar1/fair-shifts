export type RestoreFailureCode =
  | "source_missing"
  | "source_corrupt"
  | "identity_missing"
  | "decrypt_failed"
  | "restore_failed"
  | "database_exists"
  | "database_missing"
  | "database_in_use"
  | "not_verified"
  | "invalid_name";

const failureText: Record<RestoreFailureCode, string> = {
  source_missing: "No backup was found in the storage or at that path",
  source_corrupt:
    "The backup does not match the size or checksum recorded for it",
  identity_missing:
    "An age identity file is needed to open an encrypted backup (--identity)",
  decrypt_failed:
    "The backup could not be decrypted; check that the identity belongs to the backup key",
  restore_failed: "pg_restore failed; the scratch database was dropped",
  database_exists:
    "That database already exists; promote it, or drop it and run again",
  database_missing: "That database does not exist",
  database_in_use:
    "Other connections are open on the live or the restored database. Stop the site and the worker first",
  not_verified:
    "That database holds no passed restore report; run the restore first",
  invalid_name: "Database names may only use letters, digits and underscores",
};

export class RestoreFailure extends Error {
  constructor(public code: RestoreFailureCode) {
    super(failureText[code]);
  }
}
