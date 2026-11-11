import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { Engine, Project, UiTool } from "../ui/tools.js";
import type { SecretResolver } from "../secrets.js";
import { flowPath, normalizeFlow, roleVar, runAppSuite, validateFlow, type Platform } from "./maestro.js";

/**
 * app 服务：App 测试的脚本保存与试跑（Maestro）。操作手机由 Pinky 的 MCP 服务负责，
 * agent 用 Pinky 走通用例后，把步骤写成 Maestro 脚本交给这里保存、登记与试跑。
 */
export interface AppToolContext {
  engine: Engine;
  secrets: SecretResolver;
  /** maestro 可执行文件（桌面端从全局设置传入 AITEST_MAESTRO） */
  maestroBin?: string;
}

type AppEnv = Project["environments"][string] & { app?: Partial<Record<Platform, string>> };

const platform = z.enum(["android", "ios"]).describe("android 或 ios");

async function load(ctx: AppToolContext, projectId: string, env: string) {
  const project = await ctx.engine<Project>(["get-project", "--project", projectId]);
  const envCfg = project.environments[env] as AppEnv | undefined;
  if (!envCfg) throw new Error(`项目未配置环境：${env}`);
  return { project, envCfg };
}

export function appTools(ctx: AppToolContext): UiTool[] {
  return [
    {
      name: "app_info",
      description: "查询要测的 App：该平台的包名 / Bundle ID、脚本中可用的变量（APP_ID、角色账号变量名）与脚本目录",
      input: { project_id: z.string(), env: z.string(), platform },
      handler: async ({ project_id, env, platform: p }) => {
        const { envCfg } = await load(ctx, project_id, env);
        const roles = await ctx.engine<{ role_name: string }[]>(["list-roles", "--project", project_id]);
        return {
          platform: p,
          app_id: envCfg.app?.[p as Platform] ?? null,
          configured_platforms: Object.keys(envCfg.app ?? {}).filter((k) => envCfg.app?.[k as Platform]),
          variables: [
            "APP_ID", "PLATFORM",
            ...roles.flatMap((r) => [`${roleVar(r.role_name)}_USERNAME`, `${roleVar(r.role_name)}_PASSWORD`].map((v) => `${v}（角色：${r.role_name}）`)),
          ],
          flow_dir: "scripts/app",
          note: envCfg.app?.[p as Platform] ? undefined : "该环境没有配置此平台的 App，请让用户在项目设置的执行环境中填写",
        };
      },
    },
    {
      name: "save_app_flow",
      description: "保存用例的 Maestro 脚本（scripts/app/<用例ID>.yaml，Android 与 iOS 共用）并登记，在 workspace git 中提交",
      input: { project_id: z.string(), case_id: z.string(), yaml: z.string().describe("Maestro 脚本：appId: ${APP_ID}，--- 之后是步骤") },
      handler: async ({ project_id, case_id, yaml }) => {
        const errors = validateFlow(yaml);
        if (errors.length) throw new Error(errors.join("；"));
        const project = await ctx.engine<Project>(["get-project", "--project", project_id]);
        const { abs, rel } = flowPath(project.workspace_path, case_id);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, normalizeFlow(yaml, case_id));
        const script = await ctx.engine(["register-script", "--project", project_id, "--case", case_id, "--path", rel, "--framework", "maestro"]);
        return { path: rel, script };
      },
    },
    {
      name: "run_app_flow",
      description: "用 Maestro 试跑 App 脚本（不入库，用于确认刚保存的脚本在该平台可通过）",
      input: {
        project_id: z.string(),
        env: z.string(),
        platform,
        case_ids: z.array(z.string()).optional(),
        device: z.string().optional().describe("设备 ID；连接了多台设备时必须指定"),
      },
      handler: async ({ project_id, env, platform: p, case_ids, device }) => {
        const { project, envCfg } = await load(ctx, project_id, env);
        const roles = await ctx.engine<{ role_name: string }[]>(["list-roles", "--project", project_id]);
        const secretEnv = await ctx.secrets.resolve(project_id, env, { roles: roles.map((r) => r.role_name) });
        const out = await runAppSuite({
          workspace: project.workspace_path,
          platform: p,
          appId: envCfg.app?.[p as Platform] ?? "",
          caseIds: case_ids,
          device,
          roles: secretEnv.AITEST_ROLES ? JSON.parse(secretEnv.AITEST_ROLES) : [],
          maestroBin: ctx.maestroBin,
        });
        return { exit_code: out.exitCode, errors: out.errors, results: out.results.map(({ reviews: _r, ...r }) => r) };
      },
    },
  ];
}

export const APP_SERVER = { name: "app", description: "App 测试：Maestro 脚本保存与试跑（操作手机用 Pinky）" };
