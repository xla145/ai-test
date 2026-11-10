import { describe, expect, it } from "vitest";
import { evaluateCommand, evaluateFileChange } from "../src/main/approval.js";

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
