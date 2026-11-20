import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { caseHash, decodeContractOutput, sha256, validateExecutionContract, type ExecutionContract } from "@ai-test/mcp-servers";
import type { ExploreCaseBrief } from "./prompts.js";

// 升级转换规则时递增，让已缓存的语义计划重新转换。
const REVISION = 11;
interface Entry {
  revision: number;
  fingerprint: string;
  contract: ExecutionContract;
  contractHash: string;
  script?: { path: string; hash: string; stepsHash: string };
  savedAt?: string;
}
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value;

/** 每个用例/环境一个文件；不存凭据，不缓存页面坐标或会话 ref。 */
export class UiExecutionContracts {
  private file: string;
  private versionFile: string;
  readonly artifactPath: string;
  cacheReason = "尚无缓存计划";
  readonly fingerprint: string;
  constructor(workspace: string, projectId: string, env: string, caseId: string,
    private source: ExploreCaseBrief, private roles: string[], environment: unknown, selectedRole?: string, dataFingerprint?: string) {
    this.file = join(workspace, ".aitest", "ui-contracts", `${sha256(JSON.stringify([projectId, env, caseId]))}.json`);
    // Narrowed fingerprint: environment is reduced to base_url + capability flags
    // (login config changes don't affect contract output). Data catalog is limited
    // to items bound to this case (new unrelated recipes don't invalidate).
    const envBaseUrl = environment && typeof environment === "object" && "base_url" in environment ? (environment as { base_url: string }).base_url : undefined;
    const relevantData = (source.available_data ?? []).filter(d =>
      source.data_refs?.includes(d.key));
    this.fingerprint = sha256(JSON.stringify(canonical({ revision: REVISION, projectId, env, caseId,
      source: { title: source.title, steps: source.steps, expected: source.expected, preconditions: source.preconditions, data_refs: source.data_refs },
      capabilities: source.capabilities, baseUrl: envBaseUrl, roles: [...roles].sort(), relevantData, selectedRole, dataFingerprint })));
    this.versionFile = join(dirname(this.file), "versions", `${this.fingerprint}.json`);
    this.artifactPath = relative(workspace, this.versionFile);
  }
  read(): Entry | undefined {
    try {
      let data = JSON.parse(readFileSync(this.file, "utf8")) as Entry;
      if (data.fingerprint !== this.fingerprint) {
        this.cacheReason = "用例、角色、环境或转换规则已变化";
        data = JSON.parse(readFileSync(this.versionFile, "utf8")) as Entry;
      }
      if (data.revision !== REVISION || data.fingerprint !== this.fingerprint || data.contractHash !== sha256(JSON.stringify(canonical(data.contract)))) {
        this.cacheReason = "计划版本或完整性校验不匹配"; return undefined;
      }
      if (data.contract.status === "needs_clarification") {
        this.cacheReason = "旧计划包含待澄清项，不复用主缓存";
        return undefined;
      }
      this.cacheReason = "已命中持久化计划";
      if (this.source.preconditions?.length && !data.contract.preconditionChecks?.length) { this.cacheReason = "旧计划缺少原子前置检查"; return undefined; }
      return { ...data, contract: validateExecutionContract(data.contract, this.source, this.roles) };
    } catch { return undefined; }
  }
  parse(message: string): ExecutionContract {
    const fenced = message.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
    return validateExecutionContract(decodeContractOutput(JSON.parse(fenced ? fenced[1] : message)), this.source, this.roles);
  }
  parseRepair(original: string, error: unknown, message: string): ExecutionContract {
    const contract = this.parse(message);
    // Syntax errors have no usable field tree; the source-fidelity validator above
    // still applies. For schema errors preserve every field outside error paths.
    if (error instanceof SyntaxError) return contract;
    const decode = (text: string) => decodeContractOutput(JSON.parse(text.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, "$1")));
    const issues = (error as { issues: { code: string; path: PropertyKey[]; keys?: string[] }[] }).issues;
    const allowed = issues.flatMap(issue => issue.code === "unrecognized_keys"
      ? (issue.keys ?? []).map(key => [...issue.path, key]) : [issue.path]);
    const compare = (before: unknown, after: unknown, path: string[]) => {
      if (allowed.some(p => p.length === path.length && p.every((key, i) => String(key) === path[i]))) return;
      if (JSON.stringify(canonical(before)) === JSON.stringify(canonical(after))) return;
      if (before && after && typeof before === "object" && typeof after === "object" && Array.isArray(before) === Array.isArray(after)) {
        for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
          compare((before as any)[key], (after as any)[key], [...path, key]);
        }
        return;
      }
      throw new Error(`结构修复修改了错误字段以外的内容：${path.join(".")}`);
    };
    compare(decode(original), decode(message), []);
    return contract;
  }
  saveFailure(message: string, error: unknown): string {
    const path = join(dirname(this.file), "failures", `${this.fingerprint}-${randomUUID()}.json`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ revision: REVISION, fingerprint: this.fingerprint,
      savedAt: new Date().toISOString(), message, error: error instanceof Error ? error.message : String(error) }, null, 2) + "\n", { mode: 0o600 });
    return relative(dirname(dirname(dirname(this.file))), path);
  }
  save(contract: ExecutionContract, script?: Entry["script"]) {
    validateExecutionContract(contract, this.source, this.roles);
    mkdirSync(dirname(this.file), { recursive: true });
    const content = JSON.stringify({ revision: REVISION, fingerprint: this.fingerprint, sourceHash: caseHash(this.source), savedAt: new Date().toISOString(), contract, contractHash: sha256(JSON.stringify(canonical(contract))), ...(script ? { script } : {}) }, null, 2) + "\n";
    // Clarification is a diagnostic artifact, never an active executable plan.
    if (contract.status === "needs_clarification") rmSync(this.file, { force: true });
    for (const path of contract.status === "ready" ? [this.versionFile, this.file] : [this.versionFile]) {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.${randomUUID()}.tmp`;
      writeFileSync(tmp, content, { mode: 0o600 });
      renameSync(tmp, path);
    }
  }
}
