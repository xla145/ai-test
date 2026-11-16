import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sha256, validateExecutionContract, type ExecutionContract } from "@ai-test/mcp-servers";
import type { ExploreCaseBrief } from "./prompts.js";

// 升级转换规则时递增，让已缓存的语义计划重新转换。
const REVISION = 2;
interface Entry {
  revision: number;
  fingerprint: string;
  contract: ExecutionContract;
  contractHash: string;
  script?: { path: string; hash: string; stepsHash: string };
}
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value;

/** 每个用例/环境一个文件；不存凭据，不缓存页面坐标或会话 ref。 */
export class UiExecutionContracts {
  private file: string;
  readonly fingerprint: string;
  constructor(workspace: string, projectId: string, env: string, caseId: string,
    private source: ExploreCaseBrief, private roles: string[], environment: unknown) {
    this.file = join(workspace, ".aitest", "ui-contracts", `${sha256(JSON.stringify([projectId, env, caseId]))}.json`);
    this.fingerprint = sha256(JSON.stringify(canonical({ revision: REVISION, projectId, env, caseId,
      source: { title: source.title, steps: source.steps, expected: source.expected, preconditions: source.preconditions, data_refs: source.data_refs }, roles: [...roles].sort(), environment })));
  }
  read(): Entry | undefined {
    try {
      const data = JSON.parse(readFileSync(this.file, "utf8")) as Entry;
      if (data.revision !== REVISION || data.fingerprint !== this.fingerprint || data.contractHash !== sha256(JSON.stringify(canonical(data.contract)))) return undefined;
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
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify({ revision: REVISION, fingerprint: this.fingerprint, contract, contractHash: sha256(JSON.stringify(canonical(contract))), ...(script ? { script } : {}) }, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
