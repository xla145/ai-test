import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { toCode, type LocatorSpec } from "./locator.js";

/**
 * 探索录制 → 确定性 Playwright 脚本（架构文档第 7 节）。
 * 一个用例一个 spec 文件，文件头注释写用例 ID；登录态用 storageState 复用，不写明文密码。
 */
export const DEFAULT_ROLE = "default";

type Base = { role?: string };
export type Step = Base &
  (
    | { action: "goto"; url: string }
    | { action: "click"; target: LocatorSpec }
    | { action: "fill"; target: LocatorSpec; value: string; secretEnv?: string }
    | { action: "select"; target: LocatorSpec; value: string }
    | { action: "check"; target: LocatorSpec; checked: boolean }
    | { action: "press"; key: string }
    | { action: "expectVisible"; target: LocatorSpec }
    | { action: "expectHidden"; target: LocatorSpec }
    | { action: "expectText"; target: LocatorSpec; text: string }
    | { action: "expectUrl"; pattern: string }
    | { action: "startCapture"; name: string; urlPattern: string }
    | { action: "expectRequest"; name: string; fields: Record<string, unknown>; forbidden?: string[] }
    | { action: "installClock"; time: string }
    | { action: "fastForward"; ms: number }
    | { action: "visualCheck"; description: string }
    | { action: "expectDb"; check: DbCheck }
  );

/** 数据库断言（与引擎 db.check 的 spec 一致） */
export interface DbCheck {
  db?: string;
  sql: string;
  params?: Record<string, unknown>;
  expect?: Record<string, unknown>;
  timeout_ms?: number;
  description?: string;
}

export interface SpecInput {
  caseId: string;
  title: string;
  steps: Step[];
  baseUrl?: string;
  /** 用例步骤与预期，写进注释便于反向追溯 */
  caseSteps?: string[];
  expected?: string[];
}

const s = (v: unknown) => JSON.stringify(v);

function relativeUrl(url: string, baseUrl?: string): string {
  if (baseUrl) {
    const base = baseUrl.replace(/\/$/, "");
    if (url === base) return "/";
    if (url.startsWith(base + "/") || url.startsWith(base + "?") || url.startsWith(base + "#")) return url.slice(base.length);
  }
  return url;
}

function escapeRegExp(v: string): string {
  return v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function generateSpec(input: SpecInput): string {
  const roles = [...new Set(input.steps.map((st) => st.role ?? DEFAULT_ROLE))];
  const singleNamedRole = roles.length === 1 && roles[0] !== DEFAULT_ROLE ? roles[0] : undefined;
  const pageVars = new Map<string, string>();
  roles.forEach((r, i) => {
    pageVars.set(r, r === DEFAULT_ROLE || r === singleNamedRole ? "page" : `rolePage${i + 1}`);
  });
  const helpers = new Set<string>();
  const body: string[] = [];

  for (const r of roles) {
    if (pageVars.get(r) !== "page") {
      helpers.add("openAs");
      body.push(`const ${pageVars.get(r)} = await openAs(browser, ${s(r)}); // 角色：${r}`);
    }
  }

  for (const st of input.steps) {
    const p = pageVars.get(st.role ?? DEFAULT_ROLE)!;
    const loc = "target" in st ? toCode(st.target, p) : "";
    switch (st.action) {
      case "goto":
        body.push(`await ${p}.goto(${s(relativeUrl(st.url, input.baseUrl))});`);
        break;
      case "click":
        body.push(`await ${loc}.click();`);
        break;
      case "fill":
        body.push(st.secretEnv
          ? `await ${loc}.fill(process.env[${s(st.secretEnv)}] ?? ""); // 敏感值由客户端注入`
          : `await ${loc}.fill(${s(st.value)});`);
        break;
      case "select":
        body.push(`await ${loc}.selectOption(${s(st.value)});`);
        break;
      case "check":
        body.push(`await ${loc}.setChecked(${st.checked});`);
        break;
      case "press":
        body.push(`await ${p}.keyboard.press(${s(st.key)});`);
        break;
      case "expectVisible":
        body.push(`await expect(${loc}).toBeVisible();`);
        break;
      case "expectHidden":
        body.push(`await expect(${loc}).toBeHidden();`);
        break;
      case "expectText":
        body.push(`await expect(${loc}).toContainText(${s(st.text)});`);
        break;
      case "expectUrl":
        body.push(`await expect(${p}).toHaveURL(new RegExp(${s(escapeRegExp(relativeUrl(st.pattern, input.baseUrl)))}));`);
        break;
      case "startCapture":
        helpers.add("captureRequests");
        body.push(`const ${st.name} = captureRequests(${p}, ${s(st.urlPattern)});`);
        break;
      case "expectRequest":
        helpers.add("expectCaptured");
        body.push(`await expectCaptured(${st.name}, ${s(st.fields)}${st.forbidden?.length ? `, ${s(st.forbidden)}` : ""});`);
        break;
      case "installClock":
        body.push(`await ${p}.clock.install({ time: new Date(${s(st.time)}) });`);
        break;
      case "fastForward":
        body.push(`await ${p}.clock.fastForward(${st.ms});`);
        break;
      case "expectDb":
        helpers.add("expectDb");
        body.push(`await expectDb(${s(st.check)});${st.check.description ? ` // ${st.check.description.replace(/\n/g, " ")}` : ""}`);
        break;
      case "visualCheck":
        helpers.add("visualCheck");
        body.push(`await visualCheck(${p}, testInfo, ${s(st.description)}); // AI 判定，进入人工复核队列`);
        break;
    }
  }

  const fixtures = ["page", ...(helpers.has("openAs") ? ["browser"] : [])].join(", ");
  const header = [
    `// 用例 ID：${input.caseId}`,
    `// 标题：${input.title}`,
    ...(input.caseSteps?.length ? ["// 步骤：", ...input.caseSteps.map((x, i) => `//   ${i + 1}. ${x}`)] : []),
    ...(input.expected?.length ? ["// 预期：", ...input.expected.map((x, i) => `//   ${i + 1}. ${x}`)] : []),
    "// 由 AIProbe 在探索模式生成；回归直接执行本脚本，不调用模型。",
    "// 选择器优先级：data-testid → role / label → 文本 → CSS。",
  ];
  if (singleNamedRole) helpers.add("storageStateFor");
  const imports = [`import { expect, test } from "@playwright/test";`];
  if (helpers.size) imports.push(`import { ${[...helpers].sort().join(", ")} } from "./aitest-fixtures";`);
  const use = singleNamedRole ? [`test.use({ storageState: storageStateFor(${s(singleNamedRole)}) });`, ""] : [];

  return [
    ...header,
    ...imports,
    "",
    ...use,
    `test(${s(`${input.caseId} ${input.title}`)}, async ({ ${fixtures} }, testInfo) => {`,
    ...body.map((l) => `  ${l}`),
    "});",
    "",
  ].join("\n");
}

// --------------------------------------------------------------------------- scaffold

const TEMPLATE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "templates", "ui");
export const SCAFFOLD_FILES = ["playwright.config.ts", "global-setup.ts", "aitest-fixtures.ts"];

/** 在 workspace/scripts/ui 下写入 Playwright 配置、全局登录与辅助函数（已存在且未改动时覆盖为最新模板） */
export function ensureUiScaffold(workspace: string): string {
  const dir = join(workspace, "scripts", "ui");
  mkdirSync(join(dir, ".auth"), { recursive: true });
  for (const f of SCAFFOLD_FILES) {
    const content = readFileSync(join(TEMPLATE_DIR, f), "utf8");
    const target = join(dir, f);
    if (!existsSync(target) || readFileSync(target, "utf8") !== content) writeFileSync(target, content);
  }
  return dir;
}

export function specPath(workspace: string, caseId: string): { abs: string; rel: string } {
  const rel = `scripts/ui/${caseId}.spec.ts`;
  return { abs: join(workspace, rel), rel };
}
