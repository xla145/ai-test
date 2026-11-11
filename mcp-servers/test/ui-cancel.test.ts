import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ensureUiScaffold } from "../src/ui/codegen.js";
import { runUiSuite } from "../src/ui/runner.js";

it("stops a running Playwright worker when its signal is aborted", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "aitest-cancel-"));
  const controller = new AbortController();
  let reachedStep = false;
  try {
    const dir = ensureUiScaffold(workspace);
    writeFileSync(join(dir, "tc_cancel.spec.ts"), `
      import { test } from "@playwright/test";
      test("tc_cancel", async () => {
        await test.step("[S1] waiting for stop", async () => {
          await new Promise(resolve => setTimeout(resolve, 60000));
        });
      });
    `);
    const task = runUiSuite({ workspace, baseUrl: "http://localhost", caseIds: ["tc_cancel"], signal: controller.signal,
      env: { AITEST_ROLES: "[]", AITEST_LOGIN: "" },
      timeoutMs: 15000,
      onProgress: (event) => {
        if (event.stepId === "S1" && event.status === "running") {
          reachedStep = true;
          controller.abort();
        }
      },
    });
    await expect(task).rejects.toMatchObject({ name: "AbortError" });
    expect(reachedStep).toBe(true);
  } finally { rmSync(workspace, { recursive: true, force: true }); }
}, 25000);
