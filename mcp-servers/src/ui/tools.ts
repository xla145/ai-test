import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { SecretResolver } from "../secrets.js";
import { BrowserSession } from "./browser.js";
import { caseHash, writeUiScript, type UiStep } from "./codegen.js";
import { checkData, seedData, setServerClock, type EnvConfig, type TestDataRecord } from "./envSupport.js";
import type { VisionAgentFactory } from "./midscene.js";
import { runUiSuite } from "./runner.js";
import { locateRequest, resolveTargetScope, visualTargetSchema } from "./target.js";

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
/** 本会话最近一次保存的用例与步骤，供 save_ui_script(append) 追加断言 */
const savedSteps = new WeakMap<UiToolContext, { caseId: string; steps: UiStep[] }>();

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

/**
 * 角色是用例前置条件：不以名称相似推断权限等价。
 */
export function resolveRole(requested: string, configured: string[]): string {
  if (configured.includes(requested)) return requested;
  throw new Error(`用例角色「${requested}」未配置；已配置角色：${configured.join("、") || "无"}。请明确角色绑定，不自动使用相近角色。`);
}

function rolesFromEnv(env: Record<string, string>): { role: string; username: string; password: string }[] {
  return env.AITEST_ROLES ? JSON.parse(env.AITEST_ROLES) : [];
}

const ref = z.string().describe("snapshot 返回的元素 ref，如 e12");

/** 操作结果附带操作后的页面快照，agent 不必每次操作后再单独调用 snapshot */
async function withSnapshot<T extends object>(s: BrowserSession, out: T | void): Promise<T & { snapshot?: unknown }> {
  const snapshot = await s.snapshotAfterAction().catch(() => undefined);
  return { ...(out ?? ({} as T)), ...(snapshot ? { snapshot } : { note: "未取到操作后的快照，需要时调用 snapshot" }) };
}

function browserTools(ctx: UiToolContext): UiTool[] {
  const tools = allBrowserTools(ctx);
  // 未启用 Midscene 时不提供视觉工具，免得 agent 反复尝试
  return ctx.vision ? tools : tools.filter((t) => !t.name.startsWith("ai_"));
}

function allBrowserTools(ctx: UiToolContext): UiTool[] {
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
          openView: ctx.secrets.openView ? (role) => ctx.secrets.openView!(project_id, role, env) : undefined,
        });
        s.resetRecording();
        return { project: project.name, env, base_url: envCfg.base_url, mode: ctx.cdpEndpoint ? "内嵌浏览器" : "独立 Chromium" };
      },
    },
    {
      name: "new_role_context",
      description: "以某个角色打开独立会话（只传角色名，账号由客户端注入；登录态保存为 storageState 复用）。不传角色为匿名会话。"
        + "角色名必须与项目配置完全一致；缺失时阻塞，不自动使用相近角色",
      input: { role: z.string().optional() },
      handler: async ({ role }) => {
        const { project, env } = active(ctx);
        if (!role || role === "default") return s.newRoleContext("default");
        const roles = (await ctx.engine<{ role_name: string }[]>(["list-roles", "--project", project.id])).map((r) => r.role_name);
        const name = resolveRole(role, roles);
        const envCfg = project.environments[env];
        const secretEnv = await ctx.secrets.resolve(project.id, env, { roles: [name] });
        const cred = rolesFromEnv(secretEnv).find((r) => r.role === name);
        const out = await s.newRoleContext(name, {
          storageStatePath: join(project.workspace_path, "scripts", "ui", ".auth", `${name}.json`),
          login: envCfg.login as any,
          credentials: cred ? { username: cred.username, password: cred.password } : undefined,
        });
        if (out.loggedIn || out.reusedState) return out;
        // 用户在「角色与登录」里手动登录过：内嵌浏览器沿用该角色的登录态（验证码、扫码等无法自动登录的场景）
        if (existsSync(join(project.workspace_path, "scripts", "ui", ".auth", `${name}.json`))) {
          return { ...out, manualSession: true, note: "使用在「角色与登录」中手动登录保存的登录态" };
        }
        // 说明为什么没有登录，让 agent 停下来请用户配置，而不是去代码库里找账号
        const missing = [
          ...(envCfg.login ? [] : [`环境「${env}」没有配置登录方式`]),
          ...(cred ? [] : [`角色「${name}」没有配置账号${roles.length ? `（已配置的角色：${roles.join("、")}）` : "（项目还没有配置任何角色）"}`]),
        ];
        return { ...out, hint: `未登录：${missing.join("；")}。请在「UI 测试 → 角色与登录」中配置登录方式与账号，或为该角色「手动登录」一次后重试；需要登录的用例不要继续探索。` };
      },
    },
    {
      name: "navigate",
      description: "打开页面（相对路径基于环境地址）。返回值带打开后的页面快照（snapshot），不必再单独调用 snapshot",
      input: { url: z.string() },
      handler: async ({ url }) => {
        active(ctx);
        return withSnapshot(s, await s.navigate(url));
      },
    },
    {
      name: "snapshot",
      description: "获取页面快照：可交互元素（带 ref、role、name、testId）与可见文本。navigate / click / select / press 的返回值已带操作后的快照，"
        + "只有页面还在变化或需要更长文本时才单独调用。表格单元格、状态徽标等非交互文字不在元素列表里，用 find_text 取 ref",
      input: { max_text: z.number().int().optional() },
      handler: ({ max_text }) => s.snapshot({ maxText: max_text }),
    },
    {
      name: "find_text",
      description: "按文本确定性定位元素并返回 ref（不调用视觉模型，毫秒级）：找出文本包含 text 的最内层可见元素，"
        + "用于给表格单元格、状态徽标、统计文字（如「共 2 个标签」）等非交互元素做断言。多处命中时按 context（所在行的文本）挑选；"
        + "exact=true 要求元素文本与 text 完全相同。旧 ref 在之后的快照中仍然有效",
      input: { text: z.string(), exact: z.boolean().optional(), limit: z.number().int().min(1).max(30).optional() },
      handler: async ({ text, exact, limit }) => {
        const matches = await s.findText(text, { exact, limit });
        return matches.length ? { matches } : { matches, note: "页面上没有包含该文本的可见元素：确认文字是否准确、是否需要先滚动或展开" };
      },
    },
    { name: "click", description: "点击元素。返回值带点击后的页面快照", input: { ref }, handler: async ({ ref }) => withSnapshot(s, await s.click(ref)) },
    {
      name: "type",
      description: "在输入框填写文本。敏感值不要直接传：用 secret_env 指定由客户端注入的环境变量名",
      input: { ref, text: z.string(), secret_env: z.string().optional() },
      handler: ({ ref, text, secret_env }) => s.type(ref, secret_env ? process.env[secret_env] ?? "" : text, { secretEnv: secret_env }),
    },
    { name: "select", description: "下拉选择。返回值带选择后的页面快照", input: { ref, value: z.string() }, handler: async ({ ref, value }) => withSnapshot(s, await s.select(ref, value)) },
    { name: "check", description: "勾选 / 取消勾选", input: { ref, checked: z.boolean() }, handler: ({ ref, checked }) => s.check(ref, checked) },
    {
      name: "press",
      description: "按键，如 Enter。连续按键一次传数组（如 [\"Tab\", \"Tab\", \"Enter\"]），依次按下。返回值带按键后的页面快照",
      input: { key: z.union([z.string(), z.array(z.string()).min(1).max(20)]) },
      handler: async ({ key }) => withSnapshot(s, await s.press(key)),
    },
    {
      name: "screenshot",
      description: "截图保存到 workspace/evidence。默认只截当前可见区域（图小、读得快）；确实需要整页时传 full_page=true（内嵌浏览器中始终是可见区域，需要时先滚动）。找元素优先用 snapshot",
      input: { name: z.string().optional(), full_page: z.boolean().optional() },
      handler: async ({ name, full_page }) => {
        const { project } = active(ctx);
        return { path: await s.screenshot(join(project.workspace_path, "evidence", "explore", `${name ?? Date.now()}.png`), full_page ?? false) };
      },
    },
    {
      name: "expect_visible",
      description: "断言元素可见（visible=false 断言不可见）。断言会立即验证，通过后录入脚本",
      input: { ref, visible: z.boolean().optional() },
      handler: ({ ref, visible }) => s.expectVisible(ref, visible ?? true),
    },
    { name: "expect_text", description: "断言元素包含文本", input: { ref, text: z.string() }, handler: ({ ref, text }) => s.expectText(ref, text) },
    { name: "expect_no_text", description: "断言元素不包含文本（如筛选后列表中不再出现某类记录）", input: { ref, text: z.string() }, handler: ({ ref, text }) => s.expectNoText(ref, text) },
    {
      name: "expect_value",
      description: "断言输入框 / 下拉框的当前值（原生下拉框比较 option 的 value；Element Plus 下拉框比较展示文字，包括空选时的提示文字；清空的输入框为空字符串）",
      input: { ref, value: z.string() },
      handler: ({ ref, value }) => s.expectValue(ref, value),
    },
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
      description: "断言抓到字段匹配的上报（fields 为点号路径 → 值，只匹配请求体 JSON / 表单里的字段，不匹配 URL 查询参数），forbidden 为不得出现的敏感字段",
      input: { name: z.string(), fields: z.record(z.string(), z.unknown()), forbidden: z.array(z.string()).optional() },
      handler: ({ name, fields, forbidden }) => s.expectRequest(name, fields, forbidden),
    },
    {
      name: "expect_db",
      description: "数据库断言（入库校验）：查询被测系统数据库（只读），立即验证通过后录入脚本。expect 支持 rows / min_rows / empty / value / row / contains",
      input: {
        db: z.string().optional().describe("连接名；只有一个连接时可省略"),
        sql: z.string().describe("单条只读 SQL，参数用 :name"),
        params: z.record(z.string(), z.unknown()).optional(),
        expect: z.record(z.string(), z.unknown()).optional(),
        timeout_ms: z.number().int().optional(),
        description: z.string().optional().describe("这条校验在验证什么，如「新用户已入库」"),
      },
      handler: async (check) => {
        const { project, env } = active(ctx);
        const secretEnv = await ctx.secrets.resolve(project.id, env);
        const res = await ctx.engine<{ ok: boolean; errors: string[]; rows: unknown[] }>(
          ["db-check", "--project", project.id, "--env", env, "--spec", JSON.stringify(check)], secretEnv);
        if (!res.ok) throw new Error(`断言不成立：${res.errors.join("；")}；查询结果：${JSON.stringify(res.rows.slice(0, 5))}`);
        s.recordDbCheck(check);
        return { ok: true, rows: res.rows.slice(0, 5) };
      },
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
    {
      name: "case_step",
      description: "声明接下来录制的操作与断言对应用例的第几步（从 1 开始）。每开始一个用例步骤前调用，界面据此把脚本步骤与用例步骤对照显示",
      input: { index: z.number().int().min(1) },
      handler: async ({ index }) => { s.currentCaseStep = index; return { case_step: index }; },
    },
    { name: "recording", description: "查看已录制的步骤", input: {}, handler: async () => s.recording() },
    { name: "undo", description: "撤销最后 n 步录制", input: { n: z.number().int().min(1).optional() }, handler: async ({ n }) => s.undo(n) },
    {
      name: "save_ui_script",
      description: "把录制的步骤生成为该用例的 Playwright 脚本（一个用例一个 spec）并清空录制。脚本只能由本工具生成，不要手工编辑 spec；"
        + "保存后发现缺断言：继续录制，再以 append=true 保存，追加到该用例刚保存的脚本之后",
      input: { case_id: z.string(), append: z.boolean().optional().describe("追加到本会话中该用例上次保存的步骤之后") },
      handler: async ({ case_id, append }) => {
        const { project } = active(ctx);
        const previous = savedSteps.get(ctx);
        if (append && previous?.caseId !== case_id) throw new Error("本会话中还没有保存过该用例，不能追加");
        const steps = append ? [...previous!.steps, ...s.recording()] : s.recording();
        if (!steps.length) throw new Error("没有录制的步骤");
        if (!steps.some((st) => st.action.startsWith("expect") || st.action === "visualCheck")) {
          throw new Error("脚本没有任何断言：每个预期结果都要落成 expect_* 断言");
        }
        const c = await ctx.engine<{ id: string; title: string; steps: string[]; expected: string[] }>(["get-case", "--case", case_id]);
        const { path: rel } = writeUiScript(project.workspace_path, { caseId: c.id, title: c.title, steps, baseUrl: s.baseUrl, caseSteps: c.steps, expected: c.expected, caseHash: caseHash({ title: c.title, steps: c.steps, expected: c.expected }) });
        const script = await ctx.engine(["register-script", "--project", project.id, "--case", case_id, "--path", rel]);
        savedSteps.set(ctx, { caseId: case_id, steps });
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
        const dbRuntime = await ctx.engine<Record<string, string>>(["db-runtime-env", "--project", project.id, "--env", env], secretEnv);
        const out = await runUiSuite({
          workspace: project.workspace_path,
          baseUrl: envCfg.base_url,
          caseIds: case_ids,
          env: { ...secretEnv, ...dbRuntime, ...(envCfg.login ? { AITEST_LOGIN: JSON.stringify(envCfg.login) } : {}) },
        });
        return {
          persisted: false,
          attribution_supported: false,
          note: "本次为未入库的试跑，没有 run_id；不要从报告目录猜测 run_id，也不要调用 record_attribution。失败原因写在任务结论中。",
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
      description: "（Midscene）优先传结构化 target（page/scope/control/name/label/placeholder/text），自动编译定位描述并验证区域、控件身份与唯一定位器。兼容旧 prompt。返回可录制的 ref。按任务配置的定位策略使用；优先 Midscene 时先调用本工具，定位失败再回退 snapshot / find_text。"
        + "目标元素上有文字时传 text（该元素应包含的文字）：会校验定位结果，落点偏了会改用附近包含该文字的元素，仍找不到则报错而不是返回错的元素",
      input: {
        prompt: z.string().trim().min(1).optional(),
        target: visualTargetSchema.optional().describe("单个目标：页面、从外到内的区域/对话框/列表行/表单项/选项列表、控件类型与精确身份；列表行必须给 key"),
        intent: z.enum(["click", "fill", "check"]).optional().describe("目标操作类型，用于把标签或容器解析为真实控件"),
        text: z.string().optional().describe("目标元素应包含的文字，用于校验；不传则不做文字校验；不要传参照物文字"),
      },
      handler: async (input) => {
        const { prompt, text, intent, target } = locateRequest(input);
        if (target) await resolveTargetScope(await s.page(), target);
        const agent = await vision(ctx);
        const expect = text;
        const loc = await agent.aiLocate(prompt);
        const out = await s.locateAt(loc.center[0], loc.center[1], { rect: asRect(loc.rect), expect, intent, target });
        if (out.matched === false) {
          const where = out.pointText ? `落点处是「${out.pointText}」` : "落点处没有元素";
          const hint = out.elsewhere
            ? `页面上有 ${out.elsewhere} 处包含「${expect}」，最近的离落点 ${out.nearestDistance}px：改用 find_text「${expect}」按 context 挑选`
            : `页面可见区域没有包含「${expect}」的元素：确认文字是否准确、是否需要先滚动或展开`;
          throw new Error(`视觉定位不准：${where}，不包含「${expect}」。${hint}`);
        }
        if (!out.element) throw new Error("视觉定位到的位置没有元素");
        return {
          ...out.element,
          text_verified: Boolean(expect),
          intent_verified: Boolean(intent),
          scope_verified: Boolean(target),
          target_verified: Boolean(target),
          ...(expect ? { verified: true, expected: expect } : { verified: false, note: "未校验：没有给出目标文字，请核对 text / name 是否是要找的元素" }),
          ...(out.adjusted !== undefined ? { note: `落点处是「${out.pointText ?? ""}」，已改用 ${out.adjusted}px 外包含「${expect}」的元素` } : {}),
        };
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
        return { ai_verdict: verdict, detail, review, report: agent.reportFile, note: "AI 判定已进入人工复核队列" };
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

function asRect(rect: unknown): { left: number; top: number; width: number; height: number } | undefined {
  const r = rect as Record<string, unknown> | undefined;
  return r && ["left", "top", "width", "height"].every((k) => Number.isFinite(r[k])) ? (r as { left: number; top: number; width: number; height: number }) : undefined;
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
  const dbEnv = async (projectId: string, env: string) => ctx.secrets.resolve(projectId, env);
  return [
    {
      name: "db_list",
      description: "列出环境配置的被测系统数据库连接（不含密码）",
      input: { project_id: z.string(), env: z.string() },
      handler: ({ project_id, env }) => ctx.engine(["db-list", "--project", project_id, "--env", env]),
    },
    {
      name: "db_query",
      description: "查询被测系统数据库（只允许单条只读语句，参数用 :name），用于了解数据或确认入库结果",
      input: { project_id: z.string(), env: z.string(), db: z.string().optional(), sql: z.string(), params: z.record(z.string(), z.unknown()).optional(), limit: z.number().int().max(500).optional() },
      handler: async ({ project_id, env, db, sql, params, limit }) => ctx.engine([
        "db-query", "--project", project_id, "--env", env, ...(db ? ["--conn", db] : []), "--sql", sql,
        ...(params ? ["--params", JSON.stringify(params)] : []), "--limit", String(limit ?? 50),
      ], await dbEnv(project_id, env)),
    },
    {
      name: "db_check",
      description: "执行一条数据库断言并返回是否通过（不录入脚本）",
      input: {
        project_id: z.string(), env: z.string(), db: z.string().optional(), sql: z.string(),
        params: z.record(z.string(), z.unknown()).optional(), expect: z.record(z.string(), z.unknown()).optional(),
      },
      handler: async ({ project_id, env, ...check }) => ctx.engine(
        ["db-check", "--project", project_id, "--env", env, "--spec", JSON.stringify(check)], await dbEnv(project_id, env)),
    },
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
