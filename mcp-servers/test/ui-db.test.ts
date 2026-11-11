import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runEngine } from "../src/engine.js";
import { createServer } from "../src/server.js";
import type { SecretResolver } from "../src/secrets.js";
import { startDemoApp, type DemoApp } from "./fixtures/app.js";

const ENGINE_DIR = resolve(__dirname, "../../engine");
const ROLES = [{ role: "admin", username: "alice", password: "pw-admin" }];
const LOGIN = { url: "/login", username: "#username", password: "#password", submit: "#login", success: "/dashboard" };
const secrets: SecretResolver = {
  resolve: async (_p, _e, opts) => (opts?.roles ? { AITEST_ROLES: JSON.stringify(ROLES) } : {}),
};
const sql = (dbPath: string, statement: string) =>
  execFileSync("python3", ["-c", "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.executescript(sys.argv[2]); c.commit()", dbPath, statement]);

let app: DemoApp;
let dir: string;
let dbPath: string;
let client: Client;
let projectId: string;
let caseId: string;
let persist = true;

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as { text: string }[])[0].text;
  if (res.isError) throw new Error(`${name}: ${text}`);
  return JSON.parse(text);
};

beforeAll(async () => {
  app = await startDemoApp();
  dir = mkdtempSync(join(tmpdir(), "aitest-db-"));
  dbPath = join(dir, "sut.sqlite");
  sql(dbPath, "CREATE TABLE tags (code TEXT PRIMARY KEY, status TEXT); INSERT INTO tags VALUES ('TAG-1001', 'active');");
  // 被测系统停用标签时写数据库；persist=false 模拟「接口成功但没有入库」的缺陷
  app.state.onDisable = (tag) => { if (persist) sql(dbPath, `UPDATE tags SET status = 'disabled' WHERE code = '${tag}'`); };
  const opts = { db: join(dir, "engine.sqlite"), env: { PYTHONPATH: ENGINE_DIR } };
  const engine = <T,>(args: string[]) => runEngine<T>(args, opts);
  projectId = (await engine<{ id: string }>(["init-project", "--name", "入库校验", "--workspace", join(dir, "ws"), "--environments",
    JSON.stringify({ test: { base_url: app.url, login: LOGIN, databases: { main: { type: "sqlite", path: dbPath } } } })])).id;
  await engine(["add-role", "--project", projectId, "--role", "admin"]);
  caseId = (await engine<{ id: string }>(["create-case", "--project", projectId, "--json", JSON.stringify({
    title: "标签管理-停用后入库", type: "ui", priority: "P0", steps: ["停用 TAG-1001"], expected: ["数据库中标签状态为 disabled"] })])).id;
  const server = createServer("browser", { engine: opts, secrets, headless: true });
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
}, 60_000);

afterAll(async () => {
  await client?.close();
  await app?.close();
});

describe("database verification in UI tests", () => {
  it("verifies persisted data while exploring and records it into the script", async () => {
    await call("open_project", { project_id: projectId, env: "test" });
    await call("new_role_context", { role: "admin" });
    await call("navigate", { url: "/tags" });
    const btn = (await call("snapshot")).elements.find((e: any) => e.testId === "disable-TAG-1001");
    await expect(call("expect_db", { sql: "SELECT status FROM tags WHERE code = :c", params: { c: "TAG-1001" }, expect: { value: "disabled" }, timeout_ms: 300 }))
      .rejects.toThrow("断言不成立");  // 还没停用
    await call("click", { ref: btn.ref });
    await call("expect_db", { description: "标签在数据库中已停用", sql: "SELECT status FROM tags WHERE code = :c",
      params: { c: "TAG-1001" }, expect: { value: "disabled" } });
    await expect(call("expect_db", { sql: "DELETE FROM tags" })).rejects.toThrow("只读");
    const saved = await call("save_ui_script", { case_id: caseId });
    const spec = readFileSync(join(dir, "ws", saved.path), "utf8");
    const call_ = spec.match(/await expectDb\((\{.*?\})\); \}\);/)!;
    expect(JSON.parse(call_[1])).toEqual({ description: "标签在数据库中已停用", sql: "SELECT status FROM tags WHERE code = :c",
      params: { c: "TAG-1001" }, expect: { value: "disabled" } });
    expect(spec).toContain("// 标签在数据库中已停用");
  }, 60_000);

  it("regression passes when data is persisted and fails when it is not", async () => {
    sql(dbPath, "UPDATE tags SET status = 'active'");
    app.state.disabled.clear();
    let out = await call("run_playwright_script", { case_ids: [caseId] });
    expect(out.results[0].status, JSON.stringify(out)).toBe("passed");

    persist = false;
    sql(dbPath, "UPDATE tags SET status = 'active'");
    app.state.disabled.clear();
    out = await call("run_playwright_script", { case_ids: [caseId] });
    expect(out.results[0].status).not.toBe("passed");
    expect(out.results[0].message).toContain("数据库校验失败（标签在数据库中已停用）");
  }, 120_000);
});
