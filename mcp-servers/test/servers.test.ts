import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { runEngine } from "../src/engine.js";
import { createServer } from "../src/server.js";
import { SERVERS, getServer } from "../src/servers.js";

const ENGINE_DIR = resolve(__dirname, "../../engine");

async function connect(name: string, run?: typeof runEngine, secrets = { resolve: async () => ({}) }) {
  const db = join(mkdtempSync(join(tmpdir(), "aitest-")), "db.sqlite");
  const server = createServer(name, {
    engine: { db, env: { PYTHONPATH: ENGINE_DIR } },
    secrets,
    run,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, db };
}

describe("tool definitions", () => {
  it("covers the phase-1 servers", () => {
    expect(SERVERS.map((s) => s.name)).toEqual(["doc-parser", "case-store", "case-import", "api-runner", "report"]);
  });

  it("maps arguments to engine CLI", () => {
    const lint = getServer("case-import").tools.find((t) => t.name === "lint_cases")!;
    expect(lint.toArgs({ project_id: "p1", case_ids: ["a", "b"], with_issues: true })).toEqual([
      "lint", "--project", "p1", "--case-ids", "a,b", "--with-issues",
    ]);
    const list = getServer("case-store").tools.find((t) => t.name === "list_cases")!;
    expect(list.toArgs({ project_id: "p1", execution_mode: "api" })).toEqual([
      "list-cases", "--project", "p1", "--execution-mode", "api",
    ]);
  });

  it("passes optional paging to list tools", () => {
    const list = getServer("case-store").tools.find((t) => t.name === "list_cases")!;
    expect(list.toArgs({ project_id: "p1", query: "标签", page: 2, page_size: 50 })).toEqual([
      "list-cases", "--project", "p1", "--query", "标签", "--page", "2", "--page-size", "50",
    ]);
    // 只传 page 不分页：仍返回完整列表，保持旧格式
    expect(list.toArgs({ project_id: "p1", page: 3 })).toEqual(["list-cases", "--project", "p1"]);
    const issues = getServer("case-import").tools.find((t) => t.name === "list_issues")!;
    expect(issues.toArgs({ project_id: "p1", level: "warn", page_size: 20 })).toEqual([
      "list-issues", "--project", "p1", "--level", "warn", "--page-size", "20",
    ]);
  });
});

describe("mcp server", () => {
  it("injects secrets only into the engine process, never into tool output", async () => {
    const run = vi.fn(async () => ({ run_id: "run_1", passed: 3 }));
    const secrets = { resolve: vi.fn(async () => ({ AITEST_AUTH_TOKEN: "Bearer s3cret" })) };
    const { client } = await connect("api-runner", run as unknown as typeof runEngine, secrets);
    const res = await client.callTool({ name: "run_api_suite", arguments: { project_id: "p1", env: "test" } });
    expect(secrets.resolve).toHaveBeenCalledWith("p1", "test", { roles: ["*"] });
    const [args, opts] = run.mock.calls[0] as unknown as [string[], { env: Record<string, string> }];
    expect(args).toEqual(["run-api-suite", "--project", "p1", "--env", "test"]);
    expect(opts.env.AITEST_AUTH_TOKEN).toBe("Bearer s3cret");
    expect(JSON.stringify(res)).not.toContain("s3cret");
  });

  it("calls the real python engine end to end", async () => {
    const { client } = await connect("case-store");
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("create_case");
    const created = await client.callTool({
      name: "create_case",
      arguments: { project_id: "p1", case: { title: "订单-接口越权", type: "ui", priority: "P1", steps: ["用普通角色调用订单接口"], expected: ["返回 403"] } },
    });
    expect(created.isError).toBeFalsy();
    const body = JSON.parse((created.content as { text: string }[])[0].text);
    expect(body.execution_mode).toBe("api");
    const listed = await client.callTool({ name: "list_cases", arguments: { project_id: "p1" } });
    expect(JSON.parse((listed.content as { text: string }[])[0].text)).toHaveLength(1);
  });

  it("returns engine errors as tool errors", async () => {
    const { client } = await connect("api-runner");
    const res = await client.callTool({ name: "run_api_suite", arguments: { project_id: "missing", env: "test" } });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0].text).toContain("项目不存在");
  });
});

describe("app server", () => {
  it("reports app ids and role variables, then saves and registers a maestro flow", async () => {
    const { client, db } = await connect("app");
    const ws = mkdtempSync(join(tmpdir(), "app-ws-"));
    const eng = (args: string[]) => runEngine<any>(args, { db, env: { PYTHONPATH: ENGINE_DIR } });
    const project = await eng(["init-project", "--name", "shop", "--workspace", ws, "--environments",
      JSON.stringify({ test: { base_url: "https://t", app: { android: "com.example.shop" } } })]);
    await eng(["add-role", "--project", project.id, "--role", "admin"]);
    const c = await eng(["create-case", "--project", project.id, "--json",
      JSON.stringify({ title: "订单-App端下单", type: "app", priority: "P1", steps: ["下单"], expected: ["成功"] })]);
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = await client.callTool({ name, arguments: args });
      return { error: res.isError, body: (res.content as { text: string }[])[0].text };
    };

    const info = JSON.parse((await call("app_info", { project_id: project.id, env: "test", platform: "android" })).body);
    expect(info.app_id).toBe("com.example.shop");
    expect(info.configured_platforms).toEqual(["android"]);
    expect(info.variables).toContain("ROLE_ADMIN_USERNAME（角色：admin）");
    expect(JSON.parse((await call("app_info", { project_id: project.id, env: "test", platform: "ios" })).body).note).toContain("没有配置");

    const bad = await call("save_app_flow", { project_id: project.id, case_id: c.id, yaml: "appId: com.example.shop\n---\n- launchApp\n" });
    expect(bad.error).toBe(true);
    expect(bad.body).toContain("APP_ID");

    const saved = await call("save_app_flow", { project_id: project.id, case_id: c.id,
      yaml: "appId: ${APP_ID}\n---\n- launchApp\n- tapOn: \"下单\"\n- assertVisible: \"成功\"\n" });
    expect(saved.error).toBeFalsy();
    expect(JSON.parse(saved.body).path).toBe(`scripts/app/${c.id}.yaml`);
    const scripts = await eng(["list-scripts", "--case", c.id]);
    expect(scripts).toMatchObject([{ framework: "maestro", path: `scripts/app/${c.id}.yaml` }]);
  });
});
