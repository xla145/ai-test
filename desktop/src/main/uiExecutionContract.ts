import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { caseHash, sha256, validateExecutionContract, type ExecutionContract } from "@ai-test/mcp-servers";
import type { ExploreCaseBrief } from "./prompts.js";

// 升级转换规则时递增，让已缓存的语义计划重新转换。
const REVISION = 4;
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
    private source: ExploreCaseBrief, private roles: string[], environment: unknown, selectedRole?: string) {
    this.file = join(workspace, ".aitest", "ui-contracts", `${sha256(JSON.stringify([projectId, env, caseId]))}.json`);
    this.fingerprint = sha256(JSON.stringify(canonical({ revision: REVISION, projectId, env, caseId,
      source: { title: source.title, steps: source.steps, expected: source.expected, preconditions: source.preconditions, data_refs: source.data_refs }, roles: [...roles].sort(), environment, selectedRole })));
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
      this.cacheReason = "已命中持久化计划";
      if (this.source.preconditions?.length && !data.contract.preconditionChecks?.length) { this.cacheReason = "旧计划缺少原子前置检查"; return undefined; }
      return { ...data, contract: validateExecutionContract(data.contract, this.source, this.roles) };
    } catch { return undefined; }
  }
  parse(message: string): ExecutionContract {
    const fenced = message.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
    return validateExecutionContract(JSON.parse(fenced ? fenced[1] : message), this.source, this.roles);
  }
  save(contract: ExecutionContract, script?: Entry["script"]) {
    validateExecutionContract(contract, this.source, this.roles);
    mkdirSync(dirname(this.file), { recursive: true });
    const content = JSON.stringify({ revision: REVISION, fingerprint: this.fingerprint, sourceHash: caseHash(this.source), savedAt: new Date().toISOString(), contract, contractHash: sha256(JSON.stringify(canonical(contract))), ...(script ? { script } : {}) }, null, 2) + "\n";
    for (const path of [this.versionFile, this.file]) {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.${randomUUID()}.tmp`;
      writeFileSync(tmp, content, { mode: 0o600 });
      renameSync(tmp, path);
    }
  }
}
