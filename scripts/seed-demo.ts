// Synthetic setup deliberately supplies no real unit policy or supplier credentials.
if (process.env.NODE_ENV === "production")
  throw new Error("Demo setup is unavailable in production");
Object.assign(process.env, {
  TECHNICAL_EMAIL: "technical@example.invalid",
  TECHNICAL_NAME: "מנהל טכני לדוגמה",
  MANAGER_EMAIL: "manager@example.invalid",
  MANAGER_NAME: "אחראי לדוגמה",
  MANAGER_PERSONAL_NUMBER: "0000001",
});
await import("./bootstrap");
export {};
