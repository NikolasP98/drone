import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.live.test.ts"],
    pool: "forks",
    maxWorkers: 1,
    isolate: false,
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
