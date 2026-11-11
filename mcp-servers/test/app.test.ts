import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { maestroArgs, normalizeFlow, parseJunit, roleVar, roleVariables, runAppSuite, validateFlow } from "../src/app/maestro.js";

const FLOW = `appId: \${APP_ID}
---
- launchApp
- tapOn: "标签管理"
- assertVisible: "已停用"
`;

describe("maestro flows", () => {
  it("maps role names to stable variable names", () => {
    expect(roleVar("admin")).toBe("ROLE_ADMIN");
    expect(roleVar("ops-lead")).toBe("ROLE_OPS_LEAD");
    expect(roleVar("管理员")).toBe("ROLE_E7AEA1E79086E59198");
    expect(roleVariables([{ role: "admin", username: "u", password: "p" }])).toEqual({ ROLE_ADMIN_USERNAME: "u", ROLE_ADMIN_PASSWORD: "p" });
  });

  it("validates and names flows", () => {
    expect(validateFlow(FLOW)).toEqual([]);
    expect(validateFlow(FLOW.replace("${APP_ID}", "com.example.app")).join()).toContain("APP_ID");
    expect(validateFlow(FLOW.replace(/- assertVisible.*\n/, "")).join()).toContain("断言");
    expect(validateFlow("- launchApp").join()).toContain("---");
    expect(validateFlow(FLOW + "- assertWithAI:\n    assertion: ok\n").join()).toContain("AI 断言");
    const named = normalizeFlow(FLOW, "tc_1");
    expect(named).toMatch(/^appId: \$\{APP_ID\}\nname: tc_1\n---/);
    expect(normalizeFlow(named.replace("name: tc_1", "name: 旧名字"), "tc_1")).toContain("name: tc_1");
  });

  it("builds the maestro command line", () => {
    expect(maestroArgs({ platform: "ios", appId: "com.x", device: "UDID-1", roles: [{ role: "admin", username: "u", password: "p" }] },
      ["/ws/scripts/app/tc_1.yaml"], "/out/junit.xml", "/out/debug")).toEqual([
      "--device", "UDID-1", "--platform", "ios", "test", "--format", "junit", "--output", "/out/junit.xml", "--debug-output", "/out/debug",
      "-e", "APP_ID=com.x", "-e", "PLATFORM=ios", "-e", "ROLE_ADMIN_USERNAME=u", "-e", "ROLE_ADMIN_PASSWORD=p",
      "/ws/scripts/app/tc_1.yaml",
    ]);
  });

  it("parses junit reports", () => {
    const xml = `<?xml version="1.0"?><testsuites><testsuite name="Test Suite" tests="3">
      <testcase id="tc_1" name="tc_1" classname="tc_1" time="12.5"/>
      <testcase name="tc_2" time="3"><failure message="Element not found: Text matching regex: 已停用">stack &amp; more</failure></testcase>
      <testcase name="tc_3 标题" time="1"><error message="Device emulator-5554 not found"/></testcase>
      <testcase name="下单流程" file="/ws/scripts/app/tc_4.yaml" status="ERROR" time="2"><failure>Element not found: Text matching regex: 成功</failure></testcase>
    </testsuite></testsuites>`;
    expect(parseJunit(xml, ["tc_1", "tc_2", "tc_3", "tc_4"])).toEqual([
      { case_id: "tc_1", status: "passed", duration: 12.5, message: "", evidence_paths: [], reviews: [] },
      { case_id: "tc_2", status: "failed", duration: 3, message: "Element not found: Text matching regex: 已停用\nstack & more", evidence_paths: [], reviews: [] },
      { case_id: "tc_3", status: "error", duration: 1, message: "Device emulator-5554 not found", evidence_paths: [], reviews: [] },
      // Maestro 实际的写法：失败信息是 <failure> 的文本；名字对不上时按 file 属性对应用例
      { case_id: "tc_4", status: "failed", duration: 2, message: "Element not found: Text matching regex: 成功", evidence_paths: [], reviews: [] },
    ]);
  });

  it("runs flows through maestro and collects results and screenshots", async () => {
    const ws = mkdtempSync(join(tmpdir(), "app-ws-"));
    mkdirSync(join(ws, "scripts", "app"), { recursive: true });
    writeFileSync(join(ws, "scripts", "app", "tc_ok.yaml"), normalizeFlow(FLOW, "tc_ok"));
    writeFileSync(join(ws, "scripts", "app", "tc_bad.yaml"), normalizeFlow(FLOW, "tc_bad"));
    // 假的 maestro：记录参数，按传入的脚本写 JUnit 报告，并给失败用例留一张截图
    const bin = join(ws, "fake-maestro.cjs");
    writeFileSync(bin, `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const a = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(join(ws, "args.json"))}, JSON.stringify(a));
const out = a[a.indexOf("--output") + 1], debug = a[a.indexOf("--debug-output") + 1];
const flows = a.filter((x) => x.endsWith(".yaml")).map((f) => path.basename(f, ".yaml"));
fs.mkdirSync(path.join(debug, "tc_bad"), { recursive: true });
fs.writeFileSync(path.join(debug, "tc_bad", "screenshot-❌-tc_bad.png"), "png");
fs.writeFileSync(out, "<testsuites><testsuite>" + flows.map((f) => f === "tc_bad"
  ? '<testcase name="' + f + '" time="2"><failure>Assertion is false: &quot;已停用&quot; is visible</failure></testcase>'
  : '<testcase name="' + f + '" time="5"/>').join("") + "</testsuite></testsuites>");
process.exit(flows.includes("tc_bad") ? 1 : 0);
`);
    chmodSync(bin, 0o755);
    const out = await runAppSuite({
      workspace: ws, platform: "android", appId: "com.example.shop", maestroBin: bin, device: "emulator-5554",
      roles: [{ role: "管理员", username: "admin", password: "pw" }],
    });
    expect(out.exitCode).toBe(1);
    expect(Object.fromEntries(out.results.map((r) => [r.case_id, r.status]))).toEqual({ tc_bad: "failed", tc_ok: "passed" });
    const bad = out.results.find((r) => r.case_id === "tc_bad")!;
    expect(bad.message).toContain('"已停用" is visible');
    expect(bad.evidence_paths[0]).toMatch(/^reports\/app-android-.*\/debug\/tc_bad\/.*\.png$/);
    const args = JSON.parse(readFileSync(join(ws, "args.json"), "utf8")) as string[];
    expect(args.slice(0, 5)).toEqual(["--device", "emulator-5554", "--platform", "android", "test"]);
    expect(args).toContain("APP_ID=com.example.shop");
    expect(args).toContain("ROLE_E7AEA1E79086E59198_PASSWORD=pw");

    // 只跑指定用例；没有脚本时不调用 maestro
    const one = await runAppSuite({ workspace: ws, platform: "ios", appId: "com.x", maestroBin: bin, caseIds: ["tc_ok"] });
    expect(one.results.map((r) => r.case_id)).toEqual(["tc_ok"]);
    const none = await runAppSuite({ workspace: ws, platform: "ios", appId: "com.x", maestroBin: "/nonexistent", caseIds: ["tc_missing"] });
    expect(none.errors).toEqual(["没有可执行的 App 脚本"]);
    await expect(runAppSuite({ workspace: ws, platform: "ios", appId: "com.x", maestroBin: "/nonexistent/maestro" })).rejects.toThrow("未找到 Maestro");
    await expect(runAppSuite({ workspace: ws, platform: "ios", appId: "", maestroBin: bin })).rejects.toThrow("Bundle ID");
  });
});
