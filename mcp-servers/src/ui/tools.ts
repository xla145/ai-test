import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { SecretResolver } from "../secrets.js";
import { BrowserSession } from "./browser.js";
import { ensureUiScaffold, generateSpec, specPath } from "./codegen.js";
import { checkData, seedData, setServerClock, type EnvConfig, type TestDataRecord } from "./envSupport.js";
import type { VisionAgentFactory } from "./midscene.js";
import { runUiSuite } from "./runner.js";

/**
 * 有状态的 UI 工具（browser 内含 Midscene 视觉工具，二者必须共享同一页面与 ref 表）与 env-support。
 */
export type Engine = <T = unknown>(args: string[], env?: Record<string, string>) => Promise<T>;

export interface UiToolContext {
  engine: Engine;
  secrets: SecretResolver;
  session: BrowserSession;
  vision?: VisionAgentFactory;
  cdpEndpoint?: string;
}

export interface Project {
  id: string;
  name: string;
  workspace_path: string;
  environments: Record<string, EnvConfig & { login?: Record<string, string>; testid_attribute?: string }>;
}

export interface UiTool {
  name: string;
  description: string;
  input: z.ZodRawShape;
  handler: (input: any) => Promise<unknown>;
}

export interface UiServerDef {
  name: string;
  description: string;
  tools: (ctx: UiToolContext) => UiTool[];
}

interface ActiveProject {
  project: Project;
  env: string;
}

const states = new WeakMap<UiToolContext, ActiveProject>();

function active(ctx: UiToolContext): ActiveProject {
  const a = states.get(ctx);
  if (!a) throw new Error("请先调用 browser.open_project 选择项目与执行环境");
  return a;
}

async function loadProject(ctx: UiToolContext, projectId: string, env: string): Promise<{ project: Project; envCfg: Project["environments"][string] }> {
  const project = await ctx.engine<Project>(["get-project", "--project", projectId]);
  const envCfg = project.environments[env];
  if (!envCfg) throw new Error(`项目未配置环境：${env}`);
  return { project, envCfg };
}

function rolesFromEnv(env: Record<string, string>): { role: string; username: string; password: string }[] {
  return env.AITEST_ROLES ? JSON.parse(env.AITEST_ROLES) : [];
}

const ref = z.string().describe("snapshot 返回的元素 ref，如 e12");

function browserTools(ctx: UiToolContext): UiTool[] {
  const s = ctx.session;
  return [
    {
      name: "open_project",
      description: "选择项目与执行环境（设置被测地址、testid 属性），探索前先调用",
      input: { project_id: z.string(), env: z.string() },
      handler: async ({ project_id, env }) => {
        const { project, envCfg } = await loadProject(ctx, project_id, env);
        states.set(ctx, { project, env });
        s.configure({
          baseUrl: envCfg.base_url,
          testIdAttribute: envCfg.testid_attribute,
          cdpEndpoint: ctx.cdpEndpoint,
          openView: ctx.secrets.openView ? (role) => ctx.secrets.openView!(project_id, role) : undefined,
        });
        s.resetRecording();
        return { project: project.name, env, base_url: envCfg.base_url, mode: ctx.cdpEndpoint ? "内嵌浏览器" : "独立 Chromium" };
      },
    },
    {
      name: "new_role_context",
      description: "以某个角色打开独立会话（只传角色名，账号由客户端注入；登录态保存为 storageState 复用）。不传角色为匿名会话",
      input: { role: z.string().optional() },
      handler: async ({ role }) => {
        const { project, env } = active(ctx);
        const name = role || "default";
        if (name === "default") return s.newRoleContext(name);
        const envCfg = project.environments[env];
        const secretEnv = await ctx.secrets.resolve(project.id, env, { roles: [name] });
        const cred = rolesFromEnv(secretEnv).find((r) => r.role === name);
        return s.newRoleContext(name, {
          storageStatePath: join(project.workspace_path, "scripts", "ui", ".auth", `${name}.json`),
          login: envCfg.login as any,
          credentials: cred ? { username: cred.username, password: cred.password } : undefined,
        });
      },
    },
    {
      name: "navigate",
      description: "打开页面（相对路径基于环境地址）",
      input: { url: z.string() },
      handler: ({ url }) => {
        active(ctx);
        return s.navigate(url);
      },
    },
    {
      name: "snapshot",
      description: "获取页面快照：可交互元素（带 ref、role、name、testId）与可见文本",
      input: { max_text: z.number().int().optional() },
      handler: ({ max_text }) => s.snapshot({ maxText: max_text }),
    },
    { name: "click", description: "点击元素", input: { ref }, handler: ({ ref }) => s.click(ref) },
    {
      name: "type",
      description: "在输入框填写文本。敏感值不要直接传：用 secret_env 指定由客户端注入的环境变量名",
      input: { ref, text: z.string(), secret_env: z.string().optional() },
      handler: ({ ref, text, secret_env }) => s.type(ref, secret_env ? process.env[secret_env] ?? "" : text, { secretEnv: secret_env }),
    },
    { name: "select", description: "下拉选择", input: { ref, value: z.string() }, handler: ({ ref, value }) => s.select(ref, value) },
    { name: "check", description: "勾选 / 取消勾选", input: { ref, checked: z.boolean() }, handler: ({ ref, checked }) => s.check(ref, checked) },
    { name: "press", description: "按键，如 Enter", input: { key: z.string() }, handler: ({ key }) => s.press(key) },
    {
      name: "screenshot",
      description: "截图保存到 workspace/evidence",
      input: { name: z.string().optional() },
      handler: async ({ name }) => {
        const { project } = active(ctx);
        return { path: await s.screenshot(join(project.workspace_path, "evidence", "explore", `${name ?? Date.now()}.png`)) };
      },
    },
    {
      name: "expect_visible",
      description: "断言元素可见（visible=false 断言不可见）。断言会立即验证，通过后录入脚本",
      input: { ref, visible: z.boolean().optional() },
      handler: ({ ref, visible }) => s.expectVisible(ref, visible ?? true),
    },
    { name: "expect_text", description: "断言元素包含文本", input: { ref, text: z.string() }, handler: ({ ref, text }) => s.expectText(ref, text) },
    { name: "expect_url", description: "断言当前 URL 包含片段", input: { pattern: z.string() }, handler: ({ pattern }) => s.expectUrl(pattern) },
    {
      name: "start_capture",
      description: "开始抓取 URL 含 url_pattern 的请求（埋点上报），须在触发操作之前调用",
      input: { name: z.string().describe("变量名，如 clickEvents"), url_pattern: z.string() },
      handler: ({ name, url_pattern }) => s.startCapture(name, url_pattern),
    },
    {
      name: "get_captured_requests",
      description: "查看已抓到的请求（URL、方法、解析后的请求体）",
      input: { name: z.string() },
      handler: async ({ name }) => s.getCaptured(name).slice(-50),
    },
    {
      name: "expect_request",
      description: "断言抓到字段匹配的上报（fields 为点号路径 → 值），forbidden 为不得出现的敏感字段",
      input: { name: z.string(), fields: z.record(z.string(), z.unknown()), forbidden: z.array(z.string()).optional() },
      handler: ({ name, fields, forbidden }) => s.expectRequest(name, fields, forbidden),
    },
    {
      name: "install_clock",
      description: "控制前端时间（Playwright clock），须在 navigate 之前调用",
      input: { time: z.string().describe("ISO 时间") },
      handler: ({ time }) => s.installClock(time),
    },
    { name: "fast_forward", description: "前端时间快进（毫秒）", input: { ms: z.number().int() }, handler: ({ ms }) => s.fastForward(ms) },
    {
      name: "visual_check",
      description: "视觉类预期（颜色、遮挡、截断）：录入截图检查点，回归时进入人工复核队列",
      input: { description: z.string() },
      handler: ({ description }) => s.visualCheck(description, join(active(ctx).project.workspace_path, "evidence", "explore")),
    },
    { name: "recording", description: "查看已录制的步骤", input: {}, handler: async () => s.recording() },
    { name: "undo", description: "撤销最后 n 步录制", input: { n: z.number().int().min(1).optional() }, handler: async ({ n }) => s.undo(n) },
    {
      name: "save_ui_script",
      description: "把录制的步骤生成为该用例的 Playwright 脚本（一个用例一个 spec），在 workspace git 中提交并清空录制",
      input: { case_id: z.string() },
      handler: async ({ case_id }) => {
        const { project } = active(ctx);
        const steps = s.recording();
        if (!steps.length) throw new Error("没有录制的步骤");
        if (!steps.some((st) => st.action.startsWith("expect") || st.action === "visualCheck")) {
          throw new Error("脚本没有任何断言：每个预期结果都要落成 expect_* 断言");
        }
        const c = await ctx.engine<{ id: string; title: string; steps: string[]; expected: string[] }>(["get-case", "--case", case_id]);
        ensureUiScaffold(project.workspace_path);
        const { abs, rel } = specPath(project.workspace_path, case_id);
        writeFileSync(abs, generateSpec({ caseId: c.id, title: c.title, steps, baseUrl: s.baseUrl, caseSteps: c.steps, expected: c.expected }));
        const script = await ctx.engine(["register-script", "--project", project.id, "--case", case_id, "--path", rel]);
        s.resetRecording();
        return { path: rel, script };
      },
    },
    {
      name: "run_playwright_script",
      description: "试跑 UI 脚本（不入库，用于确认刚生成的脚本可通过）",
      input: { case_ids: z.array(z.string()).optional() },
      handler: async ({ case_ids }) => {
        const { project, env } = active(ctx);
        const roles = await ctx.engine<{ role_name: string }[]>(["list-roles", "--project", project.id]);
        const secretEnv = await ctx.secrets.resolve(project.id, env, { roles: roles.map((r) => r.role_name) });
        const envCfg = project.environments[env];
        const out = await runUiSuite({
          workspace: project.workspace_path,
          baseUrl: envCfg.base_url,
          caseIds: case_ids,
          env: { ...secretEnv, ...(envCfg.login ? { AITEST_LOGIN: JSON.stringify(envCfg.login) } : {}) },
        });
        return {
          exit_code: out.exitCode,
          errors: out.errors,
          results: out.results.map(({ reviews: _r, ...r }) => r),
          stderr: out.stderr.slice(-1000),
        };
      },
    },
    // ---- Midscene 视觉工具（与浏览器共享页面与 ref） ----
    {
      name: "ai_locate",
      description: "（Midscene）用自然语言视觉定位元素，返回可录制的 ref。只在 snapshot 找不到元素时使用",
      input: { prompt: z.string() },
      handler: async ({ prompt }) => {
        const agent = await vision(ctx);
        const loc = await agent.aiLocate(prompt);
        const el = await s.refAt(loc.center[0], loc.center[1]);
        if (!el) throw new Error("视觉定位到的位置没有元素");
        return el;
      },
    },
    {
      name: "ai_assert",
      description: "（Midscene）视觉判定，结果标记为「AI 判定」并进入人工复核队列，不直接算通过",
      input: { assertion: z.string(), case_id: z.string() },
      handler: async ({ assertion, case_id }) => {
        const { project } = active(ctx);
        const agent = await vision(ctx);
        let verdict = "pass";
        let detail = "";
        try {
          await agent.aiAssert(assertion);
        } catch (e) {
          verdict = "fail";
          detail = (e as Error).message;
        }
        const shot = await s.screenshot(join(project.workspace_path, "evidence", "explore", `ai-assert-${Date.now()}.png`));
        const review = await ctx.engine(["add-review", "--case", case_id, "--kind", "ai_assert", "--description", assertion,
          "--evidence", JSON.stringify([shot]), "--ai-verdict", verdict]);
        return { ai_verdict: verdict, detail, review, note: "AI 判定已进入人工复核队列" };
      },
    },
    {
      name: "ai_act",
      description: "（Midscene）执行自然语言操作。不会录入脚本，仅在探索卡住时使用",
      input: { prompt: z.string() },
      handler: async ({ prompt }) => {
        const agent = await vision(ctx);
        await agent.aiAct(prompt);
        return { note: "该操作未录入脚本，请用 snapshot + click/type 重新走一遍以生成确定性脚本" };
      },
    },
  ];
}

async function vision(ctx: UiToolContext) {
  if (!ctx.vision) throw new Error("未启用 Midscene 视觉工具");
  return ctx.vision(await ctx.session.page());
}

function envSupportTools(ctx: UiToolContext): UiTool[] {
  const prepare = async (projectId: string, env: string) => {
    const { project, envCfg } = await loadProject(ctx, projectId, env);
    const records = await ctx.engine<TestDataRecord[]>(["list-test-data", "--project", projectId]);
    const secretEnv = await ctx.secrets.resolve(projectId, env);
    return { project, envCfg, records, deps: { authToken: secretEnv.AITEST_AUTH_TOKEN } };
  };
  return [
    {
      name: "check_data",
      description: "检查用例依赖的测试数据是否存在（keys 或 case_id 的 data_refs）",
      input: { project_id: z.string(), env: z.string(), keys: z.array(z.string()).optional(), case_id: z.string().optional() },
      handler: async ({ project_id, env, keys, case_id }) => {
        const { project, envCfg, records, deps } = await prepare(project_id, env);
        const wanted = keys ?? (case_id ? (await ctx.engine<{ data_refs: string[] }>(["get-case", "--case", case_id])).data_refs : []);
        return checkData(envCfg, wanted, records, project.workspace_path, deps);
      },
    },
    {
      name: "seed_data",
      description: "为缺失的测试数据调用造数脚本或造数接口",
      input: { project_id: z.string(), env: z.string(), keys: z.array(z.string()).min(1) },
      handler: async ({ project_id, env, keys }) => {
        const { project, envCfg, records, deps } = await prepare(project_id, env);
        return seedData(envCfg, keys, records, project.workspace_path, deps);
      },
    },
    {
      name: "set_clock",
      description: "调用被测环境的时间偏移接口（服务端时间）。前端计时请用 browser.install_clock",
      input: { project_id: z.string(), env: z.string(), time: z.string().optional(), offset_seconds: z.number().optional() },
      handler: async ({ project_id, env, time, offset_seconds }) => {
        const { envCfg, deps } = await prepare(project_id, env);
        return setServerClock(envCfg, { time, offset_seconds }, deps);
      },
    },
  ];
}

export const UI_SERVERS: UiServerDef[] = [
  { name: "browser", description: "内嵌浏览器操作、录制与脚本生成（含 Midscene 视觉工具）", tools: browserTools },
  { name: "env-support", description: "测试数据准备与时间控制", tools: envSupportTools },
];

/** 生成 results 临时文件供引擎 save-run 读取 */
export function writeTempJson(dir: string, name: string, data: unknown): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, JSON.stringify(data));
  return file;
}
