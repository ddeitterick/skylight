import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: { "@shared": resolve(__dirname, "shared/src") },
  },
  test: {
    include: [
      "shared/test/**/*.test.ts",
      "tracker/test/**/*.test.ts",
      "server/test/**/*.test.ts",
      "web/test/**/*.test.ts",
      "passes/test/**/*.test.ts",
    ],
  },
});
