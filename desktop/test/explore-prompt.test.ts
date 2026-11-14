import { describe, expect, it } from "vitest";
import { explorePrompt } from "../src/main/prompts.js";

describe("explorePrompt", () => {
  it("uses the selected locating strategy while preserving recordable actions and fallback", () => {
    const visual = explorePrompt("p1", "test", "tc_a", [], undefined, "midscene-first");
    expect(visual).toContain("需要定位新的操作目标时先调用 browser.ai_locate");
    expect(visual).toContain("视觉工具未提供或定位失败时才回退");
    expect(visual).toContain("可录制操作");
    expect(visual).not.toContain("snapshot 与 find_text 都找不到时再用");
    expect(explorePrompt("p1", "test", "tc_a")).toContain("定位策略：优先 DOM");
  });

  it("inlines the case so the agent skips reading the skill and listing cases", () => {
    const text = explorePrompt("p1", "test", "tc_a", ["管理员"], {
      title: "标签管理-停用", preconditions: ["已有标签 TAG-1"], steps: ["打开标签管理", "停用 TAG-1"], expected: ["列表显示 TAG-1", "状态为已停用"], data_refs: [],
    });
    expect(text).toContain("标题：标签管理-停用");
    expect(text).toContain("   2. 停用 TAG-1");
    expect(text).toContain("   2. 状态为已停用");
    expect(text).toContain("不必再调用 case-store.list_cases");
    expect(text).toContain("不代表没有数据依赖");
    expect(text).not.toContain("选最接近");
    expect(text).toContain("角色必须精确匹配");
    expect(text).toContain("ai_locate 优先传 target");
    expect(text).toContain("不能先按预期值寻找另一元素");
    expect(text).toContain("browser.find_text");
    expect(text).toContain("press 一次传数组");
    expect(text).toContain("传 text 让它校验结果");
  });

  it("falls back to reading the case when no brief is given, and keeps the data check when data is declared", () => {
    expect(explorePrompt("p1", "test", "tc_a")).toContain("先用 case-store.list_cases 读取该用例");
    expect(explorePrompt("p1", "test", "tc_a", [], { steps: ["s"], data_refs: ["tag"] })).toContain("env-support.check_data 检查依赖数据");
  });
});
