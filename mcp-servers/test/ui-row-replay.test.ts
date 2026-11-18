import { expect, it } from "vitest";
import { BrowserSession } from "../src/ui/browser.js";
import { toLocator } from "../src/ui/locator.js";

it("records a filtered row and replays only that row after reorder, rejecting missing and duplicate keys", async () => {
  const session = new BrowserSession({ headless: true });
  try {
    const page = await session.page();
    const row = (key: string) => `<tr><td>${key}</td><td><button onclick="this.dataset.hit='yes'">编辑</button></td></tr>`;
    await page.setContent(`<table>${row("MODEL-001")}</table>`);
    const snapshot = await session.snapshot();
    const button = snapshot.elements.find(x => x.role === "button" && x.name === "编辑")!;
    await session.click(button.ref);
    const step = session.recording().at(-1)!;
    expect(step.action).toBe("click");
    if (step.action !== "click") throw new Error("Expected click");
    expect(step.target.within).toMatchObject({ hasExactText: "MODEL-001" });
    await page.setContent(`<table>${Array.from({ length: 9 }, (_, i) => row(`MODEL-001${i}`)).join("")}${row("MODEL-001")}</table>`);
    await session.runStep(step);
    expect(await page.locator('[data-hit="yes"]').count()).toBe(1);
    expect(await page.locator('tr').last().locator('button').getAttribute('data-hit')).toBe('yes');
    await page.setContent(`<table>${row("MODEL-0010")}</table>`);
    await expect(toLocator(page, step.target).click({ timeout: 150 })).rejects.toThrow();
    expect(await page.locator('[data-hit="yes"]').count()).toBe(0);
    await page.setContent(`<table>${row("MODEL-001")}${row("MODEL-001")}</table>`);
    await expect(toLocator(page, step.target).click({ timeout: 150 })).rejects.toThrow(/strict mode/);
    expect(await page.locator('[data-hit="yes"]').count()).toBe(0);
  } finally { await session.close(); }
});
