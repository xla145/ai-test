import { defineConfig } from "vitest/config";

// Browser suites launch real Chromium processes; bound parallelism so the
// default test command is reliable on developer machines as well as CI.
// A browser test includes process startup, several DOM round trips and cleanup.
// Keep per-action product deadlines unchanged; allow the test harness to finish.
export default defineConfig({ test: { maxWorkers: 1, testTimeout: 15_000, hookTimeout: 15_000 } });
