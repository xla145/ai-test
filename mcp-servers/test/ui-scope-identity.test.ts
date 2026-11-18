import { expect, it } from "vitest";
import { candidates, type ElementInfo } from "../src/ui/locator.js";
import { generateSpec } from "../src/ui/codegen.js";

it.each([".card", '[role="dialog"]', "form", "li"])("never drops the captured %s scope for a globally unique control", css => {
  const info: ElementInfo = { tag: "button", role: "button", name: "确认", testId: "confirm", css: "main button",
    scope: { css, exactKey: "目标", inner: "button", within: { css: "main" } } };
  const specs = candidates(info);
  expect(specs.length).toBeGreaterThan(0);
  for (const spec of specs) {
    expect(spec.within).toEqual({ css, hasText: undefined, hasExactText: "目标", within: { css: "main" } });
    expect(generateSpec({ caseId: "scope", title: "scope", steps: [{ action: "click", target: spec }] }))
      .toContain('filter({ has: page.getByText("目标", { exact: true }) })');
  }
});

it("rejects malformed nested scopes during generation", () => {
  expect(() => generateSpec({ caseId: "invalid", title: "invalid", steps: [{ action: "click", target: {
    kind: "role", role: "button", name: "确认", within: { css: ".card", within: { css: "" } },
  } }] })).toThrow("缺少 CSS");
});
