import { describe, expect, it } from "vitest";
import { evaluateCommand, evaluateFileChange, evaluateMcpElicitation } from "../src/main/approval.js";

describe("install commands", () => {
  it("asks before downloading or installing software, including via a full binary path", () => {
    const ask = (c: string) => evaluateCommand({ threadId: "t", turnId: "u", itemId: "i", command: c, cwd: "/ws/proj" },
      { workspace: "/ws/proj", allowedHosts: [], productionHosts: [] }).decision;
    for (const c of ["/repo/node_modules/.bin/playwright install chromium", "npx playwright install", "npm install left-pad", "pip install x",
      "python3 -m pip install x", "brew install jq", "cd a && pnpm add x"]) expect(ask(c), c).toBe("ask");
    for (const c of ["npx playwright test", "npm test", "cat package.json", "pip list"]) expect(ask(c), c).toBe("accept");
  });
});

describe("MCP tool approvals", () => {
  const own = new Set(["case-store", "browser"]);
  const req = (serverName: string, extra: Record<string, unknown> = {}) =>
    evaluateMcpElicitation({ threadId: "t", turnId: "u", serverName, mode: "form", message: "调用工具？", requestedSchema: { type: "object", properties: {} }, ...extra }, own);
  it("accepts the client's own servers and asks for third-party, url or input requests", () => {
    expect(req("case-store").decision).toBe("accept");
    expect(req("pinky").decision).toBe("ask");
    expect(req("browser", { mode: "url", url: "https://x" }).decision).toBe("ask");
    expect(req("browser", { requestedSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } }).decision).toBe("decline");
  });
});

const ctx = { workspace: "/ws/proj", allowedHosts: ["test.example.com"], productionHosts: ["www.example.com"] };
const cmd = (command: string, cwd = "/ws/proj") => evaluateCommand({ threadId: "t", turnId: "u", itemId: "i", command, cwd }, ctx);

describe("approval policy", () => {
  it("auto-accepts ordinary commands inside the workspace", () => {
    expect(cmd("python -m pytest scripts/api").decision).toBe("accept");
    expect(cmd("curl https://api.test.example.com/users").decision).toBe("accept");
  });

  it("asks for destructive, out-of-workspace, production and non-allowlisted access", () => {
    expect(cmd("rm -rf cases").decision).toBe("ask");
    expect(cmd("ls", "/etc").decision).toBe("ask");
    expect(cmd("curl https://www.example.com/").reason).toContain("生产环境");
    expect(cmd("curl -X POST https://www.example.com/api").reason).toContain("写操作");
    expect(cmd("curl https://evil.invalid/x").reason).toContain("白名单外");
  });

  it("guards file changes", () => {
    const base = { threadId: "t", turnId: "u", itemId: "i" };
    expect(evaluateFileChange({ ...base, changes: [{ path: "/ws/proj/cases/a.json" }] }, ctx).decision).toBe("accept");
    expect(evaluateFileChange({ ...base, changes: [{ path: "scripts/api/test_api.py" }] }, ctx).decision).toBe("accept");
    expect(evaluateFileChange({ ...base, changes: [{ path: "/ws/proj/../other/x" }] }, ctx).decision).toBe("ask");
    expect(evaluateFileChange({ ...base, changes: [{ path: "/ws/proj/a", kind: "delete" }] }, ctx).decision).toBe("ask");
    expect(evaluateFileChange({ ...base, grantRoot: "/" }, ctx).decision).toBe("ask");
  });
});
