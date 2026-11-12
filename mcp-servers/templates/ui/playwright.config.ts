// 由 AIProbe 生成，请勿手工修改（客户端会按最新模板覆盖）。
// 环境由客户端执行时通过环境变量注入：AITEST_BASE_URL、AITEST_REPORT_JSON 等。
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  timeout: Number(process.env.AITEST_TEST_TIMEOUT || 30_000),
  expect: { timeout: Number(process.env.AITEST_EXPECT_TIMEOUT || 5_000) },
  retries: 0,
  workers: Number(process.env.AITEST_WORKERS || 1),
  globalSetup: "./global-setup.ts",
  outputDir: process.env.AITEST_OUTPUT_DIR || "test-results",
  reporter: [
    ["./aitest-reporter.ts"],
    ["json", { outputFile: process.env.AITEST_REPORT_JSON || "test-results/report.json" }],
    ["html", { open: "never", outputFolder: process.env.AITEST_HTML_REPORT || "playwright-report" }],
  ],
  use: {
    baseURL: process.env.AITEST_BASE_URL,
    // 开启 trace 与失败截图，作为失败归因与自愈的输入
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    testIdAttribute: process.env.AITEST_TESTID_ATTRIBUTE || "data-testid",
    headless: !process.env.AITEST_HEADED,
    actionTimeout: Number(process.env.AITEST_ACTION_TIMEOUT || 5_000),
    navigationTimeout: Number(process.env.AITEST_NAVIGATION_TIMEOUT || 30_000),
    launchOptions: process.env.AITEST_CHROMIUM_PATH ? { executablePath: process.env.AITEST_CHROMIUM_PATH } : {},
  },
});
