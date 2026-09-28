import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "node",
    testTimeout: 20000,
    hookTimeout: 60000,
    exclude: ["**/node_modules/**", "tests/e2e/**"],
  },
});
