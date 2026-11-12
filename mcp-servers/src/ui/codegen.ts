import { createHash } from "node:crypto";
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
    | { action: "expectNoText"; target: LocatorSpec; text: string }
    | { action: "expectValue"; target: LocatorSpec; value: string }
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

/** 可视化编辑用的步骤：在 Step 基础上带稳定 id 与对应的用例步骤序号（从 1 开始） */
export type UiStep = Step & { id?: string; caseStep?: number; source?: "ai" | "user" | "pick"; note?: string };

/**
 * scripts/ui/<case>.steps.json：脚本的结构化来源。spec.ts 由它生成；
 * specHash 是生成时 spec 的 sha256，spec 被手工或 AI 改过（hash 不一致）时界面降级为代码模式。
 */
export interface StepsFile {
  version: 1;
  caseId: string;
  title: string;
  baseUrl?: string;
  specHash: string;
  /** 由同组另一条用例的脚本按参数替换生成时，记录模板用例 ID */
  derivedFrom?: string;
  steps: UiStep[];
}

export interface SpecInput {
  caseId: string;
  title: string;
  steps: UiStep[];
  baseUrl?: string;
  /** 用例步骤与预期，写进注释便于反向追溯 */
  caseSteps?: string[];
  expected?: string[];
  /** 模板用例 ID：本脚本由它的步骤按参数替换生成 */
  derivedFrom?: string;
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

  withStepIds(input.steps).forEach((st) => {
    const p = pageVars.get(st.role ?? DEFAULT_ROLE)!;
    const loc = "target" in st ? toCode(st.target, p) : "";
    const title = s(stepTitle(st));
    // 每步包一层 test.step，标题带步骤 id，执行进度与失败可以映射回步骤
    const wrap = (code: string, comment?: string) => body.push(`await test.step(${title}, async () => { ${code} });${comment ? ` // ${comment}` : ""}`);
    switch (st.action) {
      case "goto":
        wrap(`await ${p}.goto(${s(relativeUrl(st.url, input.baseUrl))});`);
        break;
      case "click":
        wrap(`await ${loc}.click();`);
        break;
      case "fill":
        if (st.secretEnv) wrap(`await ${loc}.fill(process.env[${s(st.secretEnv)}] ?? "");`, "敏感值由客户端注入");
        else wrap(`await ${loc}.fill(${s(st.value)});`);
        break;
      case "select":
        wrap(`await ${loc}.selectOption(${s(st.value)});`);
        break;
      case "check":
        wrap(`await ${loc}.setChecked(${st.checked});`);
        break;
      case "press":
        wrap(`await ${p}.keyboard.press(${s(st.key)});`);
        break;
      case "expectVisible":
        wrap(`await expect(${loc}).toBeVisible();`);
        break;
      case "expectHidden":
        wrap(`await expect(${loc}).toBeHidden();`);
        break;
      case "expectText":
        // 与录制、调试时的校验一致：按页面可见文本（innerText，单元格之间有空白）比较
        wrap(`await expect(${loc}).toContainText(${s(st.text)}, { useInnerText: true });`);
        break;
      case "expectNoText":
        wrap(`await expect(${loc}).not.toContainText(${s(st.text)}, { useInnerText: true });`);
        break;
      case "expectValue":
        wrap(`await expect(${loc}).toHaveValue(${s(st.value)});`);
        break;
      case "expectUrl":
        wrap(`await expect(${p}).toHaveURL(new RegExp(${s(escapeRegExp(relativeUrl(st.pattern, input.baseUrl)))}));`);
        break;
      case "startCapture":
        helpers.add("captureRequests");
        // 变量要在后续步骤中使用，借 test.step 的返回值带出作用域
        body.push(`const ${st.name} = await test.step(${title}, async () => captureRequests(${p}, ${s(st.urlPattern)}));`);
        break;
      case "expectRequest":
        helpers.add("expectCaptured");
        wrap(`await expectCaptured(${st.name}, ${s(st.fields)}${st.forbidden?.length ? `, ${s(st.forbidden)}` : ""});`);
        break;
      case "installClock":
        wrap(`await ${p}.clock.install({ time: new Date(${s(st.time)}) });`);
        break;
      case "fastForward":
        wrap(`await ${p}.clock.fastForward(${st.ms});`);
        break;
      case "expectDb":
        helpers.add("expectDb");
        wrap(`await expectDb(${s(st.check)});`, st.check.description?.replace(/\n/g, " "));
        break;
      case "visualCheck":
        helpers.add("visualCheck");
        wrap(`await visualCheck(${p}, testInfo, ${s(st.description)});`, "AI 判定，进入人工复核队列");
        break;
    }
  });

  const fixtures = ["page", ...(helpers.has("openAs") ? ["browser"] : [])].join(", ");
  const header = [
    `// 用例 ID：${input.caseId}`,
    `// 标题：${input.title}`,
    ...(input.caseSteps?.length ? ["// 步骤：", ...input.caseSteps.map((x, i) => `//   ${i + 1}. ${x}`)] : []),
    ...(input.expected?.length ? ["// 预期：", ...input.expected.map((x, i) => `//   ${i + 1}. ${x}`)] : []),
    input.derivedFrom
      ? `// 由 AIProbe 按参数替换自用例 ${input.derivedFrom} 的脚本生成；回归直接执行本脚本，不调用模型。`
      : "// 由 AIProbe 在探索模式生成；回归直接执行本脚本，不调用模型。",
    "// 选择器优先级：data-testid → role / label → 文本 → 限定到行内 → CSS（不用生成的 id / class 和行号）。",
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

// --------------------------------------------------------------------------- 步骤描述

/** 补齐步骤 id（S1、S2…），已有 id 保持不变 */
export function withStepIds(steps: UiStep[]): (UiStep & { id: string })[] {
  const used = new Set(steps.map((st) => st.id).filter(Boolean));
  let n = 0;
  return steps.map((st) => {
    if (st.id) return st as UiStep & { id: string };
    let id: string;
    do id = `S${++n}`; while (used.has(id));
    used.add(id);
    return { ...st, id };
  });
}

/** test.step 标题：「[S3] 点击 按钮「近30日」」，报告器据此取回步骤 id */
export function stepTitle(st: UiStep & { id: string }): string {
  const text = describeStep(st).replace(/\s+/g, " ");
  return `[${st.id}] ${text.length > 80 ? `${text.slice(0, 79)}…` : text}`;
}

/** 从 test.step 标题中解析步骤 id */
export function stepIdFromTitle(title: string): string | undefined {
  return title.match(/^\[(S\d+|[A-Za-z][\w-]{0,31})\]/)?.[1];
}

export function describeTarget(t: LocatorSpec): string {
  const own = (() => {
    switch (t.kind) {
      case "testid": return `testid「${t.value}」`;
      case "role": return `${t.role}「${t.name}」`;
      case "label": return `标签「${t.value}」`;
      case "placeholder": return `占位「${t.value}」`;
      case "text": return `文本「${t.value}」`;
      case "css": return t.hasText ? `${t.value}「${t.hasText}」` : t.value;
    }
  })();
  return t.within ? `「${t.within.hasText}」所在行的 ${own}` : own;
}

export function describeStep(st: Step): string {
  switch (st.action) {
    case "goto": return `打开 ${st.url}`;
    case "click": return `点击 ${describeTarget(st.target)}`;
    case "fill": return `在 ${describeTarget(st.target)} 输入 ${st.secretEnv ? "（敏感值）" : `「${st.value}」`}`;
    case "select": return `在 ${describeTarget(st.target)} 选择「${st.value}」`;
    case "check": return `${st.checked ? "勾选" : "取消勾选"} ${describeTarget(st.target)}`;
    case "press": return `按键 ${st.key}`;
    case "expectVisible": return `断言可见 ${describeTarget(st.target)}`;
    case "expectHidden": return `断言隐藏 ${describeTarget(st.target)}`;
    case "expectText": return `断言 ${describeTarget(st.target)} 包含「${st.text}」`;
    case "expectNoText": return `断言 ${describeTarget(st.target)} 不包含「${st.text}」`;
    case "expectValue": return st.value ? `断言 ${describeTarget(st.target)} 的值为「${st.value}」` : `断言 ${describeTarget(st.target)} 为空`;
    case "expectUrl": return `断言 URL 包含 ${st.pattern}`;
    case "startCapture": return `开始捕获请求 ${st.urlPattern}`;
    case "expectRequest": return `断言请求 ${st.name} 含 ${JSON.stringify(st.fields)}`;
    case "installClock": return `固定前端时间 ${st.time}`;
    case "fastForward": return `时间快进 ${st.ms}ms`;
    case "visualCheck": return `视觉判定：${st.description}`;
    case "expectDb": return `数据库断言${st.check.description ? `：${st.check.description}` : ""}`;
  }
}

// --------------------------------------------------------------------------- scaffold

const TEMPLATE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "templates", "ui");
export const SCAFFOLD_FILES = ["playwright.config.ts", "global-setup.ts", "aitest-fixtures.ts", "aitest-embedded.ts", "aitest-reporter.ts"];

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

export function stepsPath(workspace: string, caseId: string): { abs: string; rel: string } {
  const rel = `scripts/ui/${caseId}.steps.json`;
  return { abs: join(workspace, rel), rel };
}

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** 由步骤生成 spec，同时写出 steps.json（脚本的结构化来源），返回 spec 的相对路径 */
export function writeUiScript(workspace: string, input: SpecInput): { path: string; stepsPath: string } {
  ensureUiScaffold(workspace);
  const steps = withStepIds(input.steps);
  const code = generateSpec({ ...input, steps });
  const spec = specPath(workspace, input.caseId);
  const meta = stepsPath(workspace, input.caseId);
  writeFileSync(spec.abs, code);
  const file: StepsFile = { version: 1, caseId: input.caseId, title: input.title, baseUrl: input.baseUrl, specHash: sha256(code),
    ...(input.derivedFrom ? { derivedFrom: input.derivedFrom } : {}), steps };
  writeFileSync(meta.abs, JSON.stringify(file, null, 2) + "\n");
  return { path: spec.rel, stepsPath: meta.rel };
}
