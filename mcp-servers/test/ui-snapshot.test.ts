import { afterEach, beforeEach, expect, it } from "vitest";
import { BrowserSession } from "../src/ui/browser.js";

let session: BrowserSession;
beforeEach(() => { session = new BrowserSession({ headless: true }); });
afterEach(async () => { await session.close(); });

it("omits unchanged action snapshots, reuses refs, and reports changed input values", async () => {
  const page = await session.page();
  await page.setContent('<input aria-label="关键词"><button>查询</button>');
  const first = (await session.snapshotAfterAction())!;
  const input = first.elements.find(e => e.role === "textbox")!;
  const repeated = (await session.snapshotAfterAction())!;
  expect(repeated).toMatchObject({ unchanged: true, elements: [], text: "" });
  // Repeated observations must not consume refs or invalidate the previously returned one.
  for (let i = 0; i < 12; i++) await session.snapshotAfterAction();
  expect((await session.snapshot()).elements.find(e => e.role === "textbox")!.ref).toBe(input.ref);
  await session.type(input.ref, "模型");
  const changed = (await session.snapshotAfterAction())!;
  expect(changed).not.toHaveProperty("unchanged");
  expect(changed.elements.find(e => e.role === "textbox")).toMatchObject({ ref: input.ref, value: "模型" });
  await session.expectValue(input.ref, "模型");
  expect(session.recording().at(-1)?.action).toBe("expectValue");
}, 20000);

it("pages large snapshots without hiding omitted controls or preventing their use", async () => {
  const page = await session.page();
  await page.setContent(Array.from({ length: 130 }, (_, i) => `<button onclick="this.textContent='完成'">操作 ${i}</button>`).join(""));
  const first = await session.snapshot();
  expect(first.elements).toHaveLength(90);
  expect(first).toMatchObject({ total_elements: 130, next_offset: 90 });
  const second = await session.snapshot({ offset: first.next_offset, maxElements: 90 });
  expect(second.elements).toHaveLength(40);
  expect(second).not.toHaveProperty("next_offset");
  expect(second.elements[0].name).toBe("操作 90");
  await session.click(second.elements.at(-1)!.ref);
  expect(await page.locator("button").last().innerText()).toBe("完成");
});

it("keeps a full explicit snapshot available and bounds repeated context size", async () => {
  const page = await session.page();
  await page.setContent(Array.from({ length: 250 }, (_, i) => `<button>模型管理操作 ${i}</button>`).join(""));
  const full = await session.snapshot({ maxElements: 300 });
  const compact = (await session.snapshotAfterAction())!;
  const repeated = (await session.snapshotAfterAction())!;
  const sizes = [full, compact, repeated].map(value => JSON.stringify(value).length);
  expect(compact.elements).toHaveLength(90);
  expect(sizes[1]).toBeLessThan(sizes[0] * .5);
  expect(sizes[2]).toBeLessThan(sizes[1] * .1);
  expect((await session.snapshot({ maxElements: 300 })).elements).toHaveLength(250);
});

it("does not reuse unchanged status or refs across document navigation", async () => {
  const page = await session.page();
  await page.goto('data:text/html,<button>查询</button>');
  const first = (await session.snapshotAfterAction())!;
  await page.goto('data:text/html,<button>查询</button>#new');
  // A genuine new document gives elements new node identities even with identical content.
  await page.reload();
  const next = (await session.snapshotAfterAction())!;
  expect(next).not.toHaveProperty("unchanged");
  expect(next.elements[0].ref).not.toBe(first.elements[0].ref);
});

it("does not retarget an old ref when a table recycles the same DOM node for another record", async () => {
  const page = await session.page();
  await page.setContent('<table><tr><td>MODEL-A</td><td><button>编辑</button></td></tr></table>');
  const first = await session.snapshot();
  const old = first.elements.find(e => e.role === "button")!.ref;
  await page.locator("td").first().evaluate(el => { el.textContent = "MODEL-B"; });
  const next = await session.snapshot();
  expect(next.elements.find(e => e.role === "button")!.ref).not.toBe(old);
  await expect(session.click(old)).rejects.toThrow();
}, 20000);
