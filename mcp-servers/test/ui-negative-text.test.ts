import type { Page } from "playwright-core";
import { afterEach, expect, it, vi } from "vitest";
import { BrowserSession } from "../src/ui/browser.js";

afterEach(() => vi.restoreAllMocks());

// Real BrowserSession control flow, mocked Playwright reads; no browser required.
// The real-browser counterpart is in ui-target.test.ts.
for (const mode of ["explore", "replay"] as const) {
  const harness = () => {
    const session = new BrowserSession();
    const innerText = vi.fn();
    const page = { getByTestId: () => ({ innerText }) } as unknown as Page;
    const target = { kind: "testid" as const, value: "status" };
    vi.spyOn(session, "page").mockResolvedValue(page);
    vi.spyOn(session as any, "target").mockResolvedValue({ page, spec: target, role: "default" });
    const run = () => mode === "explore" ? session.expectNoText("e1", "错误", 200)
      : session.runStep({ action: "expectNoText", target, text: "错误" }, { timeoutMs: 200 });
    return { session, innerText, run };
  };
  it.each(["Timeout 200ms exceeded", "strict mode violation"])(`${mode}: preserves %s and never records a passing assertion`, async message => {
    const { session, innerText, run } = harness();
    const error = new Error(message);
    innerText.mockRejectedValue(error);
    await expect(run()).rejects.toBe(error);
    expect(session.recording()).toHaveLength(0);
    expect(innerText).toHaveBeenCalledExactlyOnceWith({ timeout: 200 });
  });
  it(`${mode}: allows genuinely empty text`, async () => {
    const { innerText, run } = harness();
    innerText.mockResolvedValue("");
    await expect(run()).resolves.toBeDefined();
  });
  it(`${mode}: waits for forbidden text to change`, async () => {
    const { innerText, run } = harness();
    innerText.mockResolvedValueOnce("错误").mockResolvedValue("完成");
    await expect(run()).resolves.toBeDefined();
    expect(innerText).toHaveBeenCalledTimes(2);
  });
  it(`${mode}: rejects forbidden text that never disappears`, async () => {
    const { innerText, run } = harness();
    innerText.mockResolvedValue("错误");
    await expect(run()).rejects.toThrow("断言不成立");
  });
  it(`${mode}: does not treat a target disappearing during polling as success`, async () => {
    const { session, innerText, run } = harness();
    const error = new Error("Target disappeared");
    innerText.mockResolvedValueOnce("错误").mockRejectedValue(error);
    await expect(run()).rejects.toBe(error);
    expect(session.recording()).toHaveLength(0);
  });
}
