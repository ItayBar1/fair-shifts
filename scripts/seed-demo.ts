// Synthetic setup deliberately supplies no real unit policy or supplier credentials.
if (process.env.NODE_ENV === "production")
  throw new Error("Demo setup is unavailable in production");
Object.assign(process.env, {
  TECHNICAL_EMAIL: "technical@example.invalid",
  TECHNICAL_NAME: "מנהל טכני לדוגמה",
  MANAGER_EMAIL: "manager@example.invalid",
  MANAGER_FIRST_NAME: "אחראי",
  MANAGER_LAST_NAME: "לדוגמה",
  MANAGER_GENDER: "other",
  MANAGER_PHONE: "0500000001",
});
await import("./bootstrap");
export {};
