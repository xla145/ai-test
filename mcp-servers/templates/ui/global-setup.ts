// 由 AIProbe 生成：执行前为各角色登录并保存 storageState（.auth/<角色>.json）。
// 账号由客户端从系统钥匙串读取后通过环境变量注入，不写进脚本：
//   AITEST_ROLES  JSON：[{ "role": "admin", "username": "...", "password": "..." }]
//   AITEST_LOGIN  JSON：{ "url": "/login", "username": "<选择器>", "password": "<选择器>", "submit": "<选择器>", "success": "<登录后 URL 片段>" }
import { chromium, type FullConfig } from "@playwright/test";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

interface RoleCred { role: string; username: string; password: string }
interface LoginRecipe { url: string; username: string; password: string; submit: string; success?: string }

export default async function globalSetup(config: FullConfig) {
  const roles: RoleCred[] = JSON.parse(process.env.AITEST_ROLES || "[]");
  const recipe: LoginRecipe | undefined = process.env.AITEST_LOGIN ? JSON.parse(process.env.AITEST_LOGIN) : undefined;
  if (!roles.length || !recipe) return;
  const maxAgeMs = Number(process.env.AITEST_AUTH_MAX_AGE_MIN || 60) * 60_000;
  const dir = join(__dirname, ".auth");
  mkdirSync(dir, { recursive: true });
  const use = config.projects[0]?.use ?? {};
  const browser = await chromium.launch(use.launchOptions);
  try {
    for (const cred of roles) {
      const file = join(dir, `${cred.role}.json`);
      if (existsSync(file) && Date.now() - statSync(file).mtimeMs < maxAgeMs) continue;
      const context = await browser.newContext({ baseURL: use.baseURL });
      const page = await context.newPage();
      await page.goto(recipe.url);
      await page.locator(recipe.username).fill(cred.username);
      await page.locator(recipe.password).fill(cred.password);
      await page.locator(recipe.submit).click();
      if (recipe.success) await page.waitForURL((u) => u.toString().includes(recipe.success!));
      else await page.waitForLoadState("networkidle");
      await context.storageState({ path: file });
      await context.close();
    }
  } finally {
    await browser.close();
  }
}
