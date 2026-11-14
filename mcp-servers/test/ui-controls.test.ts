import { afterEach, beforeEach, expect, it } from "vitest";
import { BrowserSession } from "../src/ui/browser.js";
import { generateSpec } from "../src/ui/codegen.js";

let session: BrowserSession;
beforeEach(() => { session = new BrowserSession({ headless: true }); });
afterEach(async () => { await session.close(); });

it("maps a form label to its editable input, validates placeholders and rejects ambiguous fields", async () => {
  const page = await session.page();
  await page.setContent(`<div class="el-form-item"><label class="el-form-item__label">菜单名称</label><input placeholder="搜索菜单"></div>`);
  const label = page.locator("label");
  const b = (await label.boundingBox())!;
  const found = await session.locateAt(b.x + 2, b.y + 2, { expect: "菜单名称", intent: "fill" });
  expect(found.element?.role).toBe("textbox");
  await session.type(found.element!.ref, "模型");
  expect(await page.locator("input").inputValue()).toBe("模型");
  const input = (await page.locator("input").boundingBox())!;
  expect((await session.locateAt(input.x + 2, input.y + 2, { expect: "搜索菜单", intent: "fill" })).matched).toBe(true);
  await page.locator(".el-form-item").evaluate(el => el.appendChild(document.createElement("input")));
  await expect(session.locateAt(b.x + 2, b.y + 2, { intent: "fill" })).rejects.toThrow("多个控件");
}, 20_000);

it("clicks the select wrapper and records exact selected text, scoped away from hidden duplicates", async () => {
  const page = await session.page();
  const field = `<div class="el-form-item"><label class="el-form-item__label">备用渠道</label><div class="el-select"><div class="el-select__wrapper" onclick="this.dataset.open='yes'" style="position:relative;width:220px;height:35px"><div class="el-select__selection"><input readonly role="combobox" aria-label="备用渠道" style="width:200px"><span class="el-select__selected-item" style="position:absolute;inset:0;background:white">阿里云源</span></div></div></div></div>`;
  await page.setContent(`<div style="display:none">${field}</div>${field}`);
  const ref = (await session.snapshot()).elements.find(e => e.role === "combobox")!.ref;
  await session.click(ref);
  expect(await page.locator(".el-select__wrapper:visible").getAttribute("data-open")).toBe("yes");
  await session.expectValue(ref, "阿里云源");
  const steps = session.recording();
  expect(steps.at(-1)).toMatchObject({ action: "expectText", exact: true, text: "阿里云源" });
  const spec = generateSpec({ caseId: "tc_controls", title: "选择渠道", steps });
  expect(spec).toContain("toHaveText");
  expect(spec).toContain("scrollIntoView({ block: \"center\"");
  expect(steps[0]).toMatchObject({ scroll: "center" });
  for (const step of steps) await session.runStep(step);
  await page.locator(".el-select__selected-item:visible").evaluate(el => { el.textContent = "阿里云源备份"; });
  await expect(session.runStep(steps.at(-1)!, { timeoutMs: 150 })).rejects.toThrow("断言不成立");
}, 20_000);

it("resolves a switch label to its checkbox and records a state-setting action", async () => {
  const page = await session.page();
  await page.setContent(`<label class="el-switch"><span>启用故障切换</span><input type="checkbox"></label>`);
  const b = (await page.locator("span").boundingBox())!;
  const result = await session.locateAt(b.x + 2, b.y + 2, { expect: "启用故障切换", intent: "check" });
  await session.check(result.element!.ref, true);
  expect(await page.locator("input").isChecked()).toBe(true);
  await session.runStep(session.recording().at(-1)!);
  expect(await page.locator("input").isChecked()).toBe(true);
}, 20_000);
