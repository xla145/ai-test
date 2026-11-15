import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { caseHash, describeStep, type StepsFile } from "@ai-test/mcp-servers";
import type { UiScriptDetail } from "../shared/ipc.js";

interface Validation { hash: string; runId: string; passed: boolean; role?: string; context?: string; reason?: string; reviews?: number; policy?: number }
export interface WorkflowReview { run_id: string; case_id: string; status: string }
export interface WorkflowContext { fingerprints?: Record<string, string>; reviews?: WorkflowReview[]; roles?: Record<string, string> }
interface Entry { history?: Validation[]; validation?: Validation; confirmedHash?: string; confirmedAt?: string }
type State = Record<string, Entry>;
export interface UiScriptState { path: string; hash: string; status: "pending" | "confirmed"; validatedRunId?: string; validationReason?: string; executionRole?: string }

/** 确认绑定环境及文件内容；脚本改动后自动回到待校验。 */
export class UiWorkflow {
  private file: string;
  constructor(private workspace: string) { this.file = join(workspace, ".aitest", "ui-workflow.json"); }
  private read(): State { return existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : {}; }
  private save(state: State) {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, this.file);
  }
  private key(env: string, id: string) { return JSON.stringify([env, id]); }
  private inside(path: string): string {
    const root = realpathSync(this.workspace);
    const target = realpathSync(resolve(this.workspace, path));
    const rel = relative(root, target);
    if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) throw new Error("脚本必须位于项目工作目录内");
    return target;
  }
  hash(path: string): string {
    return createHash("sha256").update(readFileSync(this.inside(path))).digest("hex");
  }
  /** 判断脚本是否对应当前用例内容；旧脚本没有指纹时不自动复用。 */
  reusable(path: string, input: { title?: string; steps?: string[]; expected?: string[] }): boolean {
    try {
      const meta = this.stepsFile(path);
      return meta.caseHash === caseHash(input);
    } catch { return false; }
  }
  /** 调试用：读取与 spec 一致的结构化步骤；脚本被改过或没有步骤时报错 */
  stepsFile(path: string): StepsFile {
    const spec = this.inside(path);
    const stepsFile = spec.replace(/\.spec\.ts$/, ".steps.json");
    if (stepsFile === spec || !existsSync(stepsFile)) throw new Error("该脚本没有结构化步骤，请重新生成后再调试");
    const meta = JSON.parse(readFileSync(this.inside(stepsFile), "utf8")) as StepsFile;
    if (!Array.isArray(meta.steps) || !meta.steps.length) throw new Error("脚本没有步骤");
    if (meta.specHash !== createHash("sha256").update(readFileSync(spec)).digest("hex")) throw new Error("脚本代码已被修改，步骤与代码不一致，无法单步调试");
    return meta;
  }
  /** 读取脚本与同目录的 steps.json；spec 的 hash 与生成时记录的不一致则标记为未同步 */
  detail(path: string): UiScriptDetail {
    const spec = this.inside(path);
    const code = readFileSync(spec, "utf8");
    const stepsFile = spec.replace(/\.spec\.ts$/, ".steps.json");
    if (stepsFile === spec || !existsSync(stepsFile)) return { path, code, synced: false };
    try {
      const meta = JSON.parse(readFileSync(this.inside(stepsFile), "utf8")) as StepsFile;
      if (!Array.isArray(meta.steps)) return { path, code, synced: false };
      const steps = meta.steps.map((st, i) => ({
        id: st.id ?? `S${i + 1}`, action: st.action, description: describeStep(st),
        ...(st.caseStep ? { caseStep: st.caseStep } : {}), ...(st.expectedIndices ? { expectedIndices: st.expectedIndices } : {}), ...(st.preconditionIndices ? { preconditionIndices: st.preconditionIndices } : {}), ...(st.role ? { role: st.role } : {}), ...(st.source ? { source: st.source } : {}),
      }));
      return { path, code, steps, ...(meta.source ? { source: meta.source } : {}), synced: meta.specHash === createHash("sha256").update(code).digest("hex"),
        ...(meta.derivedFrom ? { derivedFrom: meta.derivedFrom } : {}) };
    } catch {
      return { path, code, synced: false };
    }
  }
  states(env: string, scripts: Record<string, string>, context: WorkflowContext = {}): Record<string, UiScriptState> {
    const state = this.read();
    return Object.fromEntries(Object.entries(scripts).filter(([, path]) => existsSync(resolve(this.workspace, path))).map(([id, path]) => {
      const hash = this.hash(path);
      const entry = state[this.key(env, id)];
      const v = entry?.validation;
      let reason: string | undefined;
      if (v) {
        if (v.policy !== 2) reason = "历史校验未包含完整性检查，请重新试跑";
        else if (v.hash !== hash || v.context !== context.fingerprints?.[id]) reason = "脚本、用例或环境配置已变化，请重新试跑";
        else if (!v.passed) reason = v.reason || "最近一次试跑未通过，请修正后重新试跑";
        else if (v.reviews) {
          const reviews = (context.reviews ?? []).filter(r => r.run_id === v.runId && r.case_id === id);
          if (reviews.some(r => r.status === "confirmed_fail")) reason = "人工复核未通过，请修正后重新试跑";
          else if (reviews.length !== v.reviews || reviews.some(r => r.status !== "confirmed_pass")) reason = "请在人工复核中确认本次运行的全部截图，再确认脚本";
        }
      }
      const eligible = !!v && !reason && v.passed;
      return [id, { path, hash, status: eligible && entry?.confirmedHash === hash ? "confirmed" : "pending",
        validatedRunId: eligible ? v.runId : undefined, validationReason: reason, executionRole: eligible ? v.role : undefined }];
    }));
  }
  /** 开始新校验即撤销旧确认，执行中断或抛错也不能恢复旧的通过状态。 */
  begin(env: string, versions: Record<string, string>, fingerprints?: Record<string, string>) {
    this.record(env, "", versions, [], { fingerprints }, Object.fromEntries(Object.keys(versions).map(id => [id, "本次校验尚未完整结束，请重新试跑"])));
  }
  record(env: string, runId: string, versions: Record<string, string>, passed: string[], context: WorkflowContext = {}, reasons: Record<string, string> = {}, reviews: Record<string, number> = {}) {
    const state = this.read();
    for (const [id, hash] of Object.entries(versions)) {
      const previous = state[this.key(env, id)];
      state[this.key(env, id)] = { history: [...(previous?.history ?? []), ...(previous?.validation?.runId ? [previous.validation] : [])].slice(-20), validation: { hash, runId, passed: passed.includes(id), policy: 2,
        context: context.fingerprints?.[id], role: context.roles?.[id], reason: reasons[id], reviews: reviews[id] } };
    }
    this.save(state);
  }
  confirm(env: string, id: string, path: string, hash: string, context: WorkflowContext = {}) {
    const current = this.states(env, { [id]: path }, context)[id];
    if (current?.hash !== hash || !current.validatedRunId) throw new Error(current?.validationReason || "请先对当前版本完成可视化校验，试跑通过后才能确认");
    const state = this.read();
    const key = this.key(env, id);
    state[key] = { ...state[key], confirmedHash: hash, confirmedAt: new Date().toISOString() };
    this.save(state);
  }
}
