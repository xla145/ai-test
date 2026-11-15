// Each test gets an isolated context; the recorded role overrides the default binding.
import { test as base } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { storageStateFor, prepareSessionPage, recordSession } from "./aitest-fixtures";
export * from "@playwright/test";
export const test = base.extend({
  context: async ({ browser, storageState, contextOptions, baseURL }, use, testInfo) => {
    const id = testInfo.title.match(/^(tc_[\w-]+)/)?.[1];
    const bindings = JSON.parse(process.env.AITEST_ROLE_BINDINGS || "{}");
    const role = bindings[id ?? ""] || process.env.AITEST_DEFAULT_ROLE || "default";
    const roleState = storageStateFor(role);
    const state = storageState ?? (role !== "default" || (typeof roleState === "string" && existsSync(roleState)) ? roleState : undefined);
    if (typeof state === "string" && !existsSync(state)) throw new Error(`AUTH_REQUIRED: 登录态不存在，请为执行角色登录后重试`);
    const context = await browser.newContext({ ...contextOptions, baseURL, storageState: state });
    try {
      if (typeof state === "string" && existsSync(`${state}.session.json`)) {
        const session = JSON.parse(readFileSync(`${state}.session.json`, "utf8"));
        await context.addInitScript(({ origin, values }) => {
          if (location.origin === origin) for (const [key, value] of Object.entries(values)) sessionStorage.setItem(key, String(value));
        }, session);
      }
      await use(context);
    } finally { await context.close(); }
  },
  page: async ({ context, storageState }, use, testInfo) => {
    const page = await context.newPage();
    prepareSessionPage(page);
    try { await use(page); }
    finally {
      const id = testInfo.title.match(/^(tc_[\w-]+)/)?.[1];
      const bindings = JSON.parse(process.env.AITEST_ROLE_BINDINGS || "{}");
      const role = typeof storageState === "string" ? Buffer.from(basename(storageState, ".json"), "hex").toString() : bindings[id ?? ""] || process.env.AITEST_DEFAULT_ROLE || "default";
      const roleState = storageStateFor(role || "default");
      recordSession(page, role || "explicit-state", !!storageState || (typeof roleState === "string" && existsSync(roleState)));
    }
  },
});
