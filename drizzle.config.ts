import { defineConfig } from "drizzle-kit";
export default defineConfig({
  schema: "./src/server/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      "postgresql://postgres:postgres@127.0.0.1:54329/fair_shifts",
  },
});
