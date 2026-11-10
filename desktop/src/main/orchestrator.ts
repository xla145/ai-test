import { EventEmitter } from "node:events";
import { apiScriptPrompt, caseGenerationPrompt, triagePrompt, type FailureBrief } from "./prompts.js";
import type { TurnResult } from "./codex/appServer.js";
import type { ThreadStartParams } from "./codex/protocol.js";

/**
 * 编排层（架构文档第 3 节）：界面只和编排层通信；编排层驱动 Codex，凭据、审批和调度都留在这里。
 * 回归执行由编排层直接调度 pytest，不经过 Codex；只有失败用例才回到 agent。
 */
export type EngineCall = <T = unknown>(args: string[], env?: Record<string, string>) => Promise<T>;

export interface AgentEngine {
  startThread(params: ThreadStartParams): Promise<string>;
  runTurn(threadId: string, text: string, opts?: { tokenLimit?: number }): Promise<TurnResult>;
}

export interface ProjectInfo {
  id: string;
  name: string;
  workspace_path: string;
  environments: Record<string, { base_url: string; auth_header?: string; production?: boolean }>;
}

export interface RunSummary {
  run_id: string;
  total: number;
  passed: number;
  failed: number;
  error: number;
  skipped: number;
  pass_rate: number;
  failure_types: Record<string, number>;
  needs_agent: string[];
}

export interface TriageItem {
  case_id: string;
  failure_type: string;
  reason?: string;
  suggestion?: string;
}

export interface OrchestratorDeps {
  engine: EngineCall;
  agent: () => Promise<AgentEngine>;
  /** 取环境凭据（来自钥匙串），只注入引擎子进程 */
  secretEnv: (projectId: string, env: string) => Record<string, string>;
  /** 单次 agent 任务的 token 上限 */
  tokenLimit?: number;
}

export class Orchestrator extends EventEmitter {
  constructor(private readonly deps: OrchestratorDeps) {
    super();
  }

  listProjects(): Promise<ProjectInfo[]> {
    return this.deps.engine<ProjectInfo[]>(["list-projects"]);
  }

  async project(projectId: string): Promise<ProjectInfo> {
    const p = (await this.listProjects()).find((x) => x.id === projectId);
    if (!p) throw new Error(`项目不存在：${projectId}`);
    return p;
  }

  createProject(name: string, workspace: string, environments: ProjectInfo["environments"] = {}) {
    return this.deps.engine<ProjectInfo>([
      "init-project", "--name", name, "--workspace", workspace, "--environments", JSON.stringify(environments),
    ]);
  }

  importExcel(projectId: string, file: string) {
    return this.deps.engine(["import-excel", "--project", projectId, "--file", file]);
  }

  lint(projectId: string) {
    return this.deps.engine(["lint", "--project", projectId, "--with-issues"]);
  }

  listCases(projectId: string, filters: Record<string, string> = {}) {
    const args = ["list-cases", "--project", projectId];
    for (const [k, v] of Object.entries(filters)) if (v) args.push(`--${k.replace(/_/g, "-")}`, v);
    return this.deps.engine<unknown[]>(args);
  }

  updateCase(caseId: string, patch: Record<string, unknown>) {
    return this.deps.engine(["update-case", "--case", caseId, "--json", JSON.stringify(patch)]);
  }

  applyFix(caseId: string, field: string, value: unknown) {
    return this.deps.engine(["apply-fix", "--case", caseId, "--field", field, "--value", JSON.stringify(value)]);
  }

  tokenUsage(projectId: string) {
    return this.deps.engine<{ tokens: number }>(["token-usage", "--project", projectId]);
  }

  /** 接口测试主线：OpenAPI → 基线用例 → 脚本（确定性，不耗模型）；enrich=true 时让 agent 补充业务场景 */
  async generateApiSuite(projectId: string, openapiFile: string, enrich = false) {
    const generated = await this.deps.engine(["generate-api-cases", "--project", projectId, "--openapi", openapiFile]);
    let agent: TurnResult | undefined;
    if (enrich) agent = await this.agentTask(projectId, "api_script", apiScriptPrompt(projectId, openapiFile));
    const suite = await this.deps.engine(["write-api-suite", "--project", projectId]);
    return { generated, suite, agent };
  }

  /** 需求文档 → 用例（agent 任务） */
  generateCases(projectId: string, requirementFile: string) {
    return this.agentTask(projectId, "case_gen", caseGenerationPrompt(projectId, requirementFile));
  }

  /** 回归：直接跑脚本，不消耗大模型；失败且无法确定类型时才调 agent 归因 */
  async runRegression(projectId: string, env: string, opts: { autoTriage?: boolean } = {}) {
    const project = await this.project(projectId);
    const envCfg = project.environments[env];
    if (!envCfg) throw new Error(`项目未配置环境：${env}`);
    this.emit("progress", { projectId, stage: "run", env });
    const run = await this.deps.engine<RunSummary>(
      ["run-api-suite", "--project", projectId, "--env", env],
      this.deps.secretEnv(projectId, env),
    );
    let triage: TriageItem[] | undefined;
    if (opts.autoTriage !== false && run.needs_agent.length) {
      triage = await this.triage(projectId, run.run_id);
    }
    return { run, triage };
  }

  async triage(projectId: string, runId: string): Promise<TriageItem[]> {
    const failures = await this.deps.engine<FailureBrief[]>(["summarize-failures", "--run", runId]);
    const unknown = failures.filter((f) => f.failure_type === "unknown");
    const settled: TriageItem[] = failures
      .filter((f) => f.failure_type !== "unknown")
      .map((f) => ({ case_id: f.case_id, failure_type: f.failure_type ?? "unknown", reason: "确定性规则判定" }));
    if (!unknown.length) return settled;
    const turn = await this.agentTask(projectId, "triage", triagePrompt(projectId, runId, unknown));
    return [...settled, ...parseTriage(turn.message)];
  }

  /** 一个任务 = 一个 Codex thread；记录 AgentSession 与 token 用量 */
  private async agentTask(projectId: string, purpose: string, prompt: string): Promise<TurnResult> {
    const project = await this.project(projectId);
    const agent = await this.deps.agent();
    const threadId = await agent.startThread({
      cwd: project.workspace_path,
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    const session = await this.deps.engine<{ id: string }>([
      "agent-session", "--project", projectId, "--thread", threadId, "--purpose", purpose,
    ]);
    this.emit("progress", { projectId, stage: purpose, threadId });
    const result = await agent.runTurn(threadId, prompt, { tokenLimit: this.deps.tokenLimit });
    await this.deps.engine(["add-tokens", "--session", session.id, "--tokens", String(result.tokens)]);
    return result;
  }
}

/** 从 agent 最终回复中取出 JSON 数组 */
export function parseTriage(message: string): TriageItem[] {
  const fenced = message.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/);
  const raw = fenced?.[1] ?? message.slice(message.indexOf("["), message.lastIndexOf("]") + 1);
  try {
    const items = JSON.parse(raw) as TriageItem[];
    return Array.isArray(items) ? items.filter((i) => i && typeof i.case_id === "string") : [];
  } catch {
    return [];
  }
}
