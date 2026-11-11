import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { CodexAppServer } from "../src/main/codex/appServer.js";
import { buildCodexConfig } from "../src/main/codex/config.js";
import { JsonRpcPeer } from "../src/main/codex/jsonrpc.js";

/** 用两对内存流模拟 codex app-server 子进程 */
function fakeCodex(script: (server: JsonRpcPeer) => void) {
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  const server = new JsonRpcPeer(toServer, toClient);
  script(server);
  return { stdin: toServer, stdout: toClient, kill: vi.fn() };
}

describe("JsonRpcPeer", () => {
  it("handles requests in both directions and split chunks", async () => {
    const a2b = new PassThrough();
    const b2a = new PassThrough();
    const a = new JsonRpcPeer(b2a, a2b);
    const b = new JsonRpcPeer(a2b, b2a);
    b.onRequest(async (m, p) => ({ echo: m, p }));
    a.onRequest(async () => {
      throw new Error("nope");
    });
    await expect(a.request("ping", { x: 1 })).resolves.toEqual({ echo: "ping", p: { x: 1 } });
    await expect(b.request("fail")).rejects.toThrow("nope");

    const notes: unknown[] = [];
    a.on("notification", (m, p) => notes.push([m, p]));
    b2a.write('{"method":"hello",');
    b2a.write('"params":{"n":1}}\n');
    await new Promise((r) => setImmediate(r));
    expect(notes).toEqual([["hello", { n: 1 }]]);
  });
});

describe("CodexAppServer", () => {
  it("runs a turn, streams the message, tracks tokens and answers approvals", async () => {
    const approvals = { command: vi.fn(async () => "accept" as const), fileChange: vi.fn(async () => "decline" as const) };
    const decisions: unknown[] = [];
    const transport = fakeCodex((srv) => {
      srv.onRequest(async (method, params: any) => {
        if (method === "initialize") return { userAgent: "codex-test" };
        if (method === "thread/start") return { thread: { id: "th_1" } };
        if (method === "turn/start") {
          setImmediate(async () => {
            decisions.push(await srv.request("item/commandExecution/requestApproval", { threadId: "th_1", turnId: "tu_1", itemId: "i1", command: "pytest" }));
            decisions.push(await srv.request("item/fileChange/requestApproval", { threadId: "th_1", turnId: "tu_1", itemId: "i2" }));
            srv.notify("item/agentMessage/delta", { threadId: params.threadId, delta: "完成" });
            srv.notify("item/agentMessage/delta", { threadId: params.threadId, delta: "了" });
            srv.notify("thread/tokenUsage/updated", { threadId: "th_1", tokenUsage: { total: { totalTokens: 321 } } });
            srv.notify("turn/completed", { threadId: "th_1", turn: { id: "tu_1", status: "completed" } });
          });
          return { turn: { id: "tu_1" } };
        }
        throw new Error(method);
      });
    });
    const codex = new CodexAppServer({ binary: "codex", codexHome: "/tmp", approvals });
    await codex.start(transport);
    const thread = await codex.startThread({ cwd: "/ws" });
    const result = await codex.runTurn(thread, "生成用例");
    expect(result).toMatchObject({ threadId: "th_1", turnId: "tu_1", status: "completed", message: "完成了", tokens: 321 });
    expect(decisions).toEqual([{ decision: "accept" }, { decision: "decline" }]);
  });

  it("interrupts a turn that exceeds the token budget", async () => {
    const interrupts: unknown[] = [];
    const transport = fakeCodex((srv) => {
      srv.onRequest(async (method, params) => {
        if (method === "initialize") return {};
        if (method === "thread/start") return { thread: { id: "th" } };
        if (method === "turn/start") {
          setImmediate(() => srv.notify("thread/tokenUsage/updated", { threadId: "th", tokenUsage: { total: { totalTokens: 5000 } } }));
          return { turn: { id: "tu" } };
        }
        if (method === "turn/interrupt") {
          interrupts.push(params);
          srv.notify("turn/completed", { threadId: "th", turn: { id: "tu", status: "interrupted" } });
          return {};
        }
        throw new Error(method);
      });
    });
    const codex = new CodexAppServer({ binary: "codex", codexHome: "/tmp", approvals: { command: async () => "accept", fileChange: async () => "accept" } });
    await codex.start(transport);
    const result = await codex.runTurn(await codex.startThread({ cwd: "/ws" }), "x", { tokenLimit: 1000 });
    expect(result.status).toBe("interrupted_budget");
    expect(interrupts).toEqual([{ threadId: "th", turnId: "tu" }]);
  });
});

describe("buildCodexConfig", () => {
  it("registers MCP servers and an OpenAI-compatible provider without secrets", () => {
    const toml = buildCodexConfig({
      mcpServers: [{ name: "case-store", command: "/app/electron", args: ["/app/mcp/index.js", "case-store"], env: { AITEST_DB: 'C:\\db "x"' } }],
      provider: { id: "qwen", name: "Qwen", baseUrl: "https://example.invalid/v1", envKey: "QWEN_API_KEY", model: "qwen-max" },
    });
    expect(toml).toContain("[mcp_servers.case-store]");
    expect(toml).toContain('args = ["/app/mcp/index.js", "case-store"]');
    expect(toml).toContain('AITEST_DB = "C:\\\\db \\"x\\""');
    expect(toml).toContain('model_provider = "qwen"');
    expect(toml).toContain('env_key = "QWEN_API_KEY"');
    expect(toml).toContain('wire_api = "responses"');
    expect(toml).not.toContain('wire_api = "chat"');
  });
});
