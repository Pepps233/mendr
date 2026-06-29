import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**"],
    testTimeout: process.env.MENDR_E2E === "1" ? 1_200_000 : 5_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      thresholds: {
        "src/report.ts": {
          statements: 100,
          branches: 96,
          functions: 100,
          lines: 100
        },
        "src/state.ts": {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100
        },
        "src/agents/claude.ts": {
          branches: 90
        },
        "src/agents/codex.ts": {
          branches: 90
        },
        "src/orchestrator.ts": {
          branches: 90
        }
      }
    }
  }
});
