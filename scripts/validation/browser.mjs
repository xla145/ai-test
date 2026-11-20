/** Non-desktop smoke: exercises the existing synthetic preview without connecting to test systems or model providers. */
import { chromium } from "playwright-core";
import { existsSync, mkdirSync } from "node:fs";
import assert from "node:assert/strict";
const base = process.env.AITEST_PREVIEW_URL || "http://localhost:5173/";
if (!["localhost","127.0.0.1","[::1]"].includes(new URL(base).hostname)) throw new Error("Preview verification must use loopback");
const executablePath = [process.env.AITEST_CHROMIUM_BIN, chromium.executablePath(),
  ...(process.platform === "darwin" ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"] : [])].find(path=>path&&existsSync(path));
if(!executablePath) throw new Error("No installed browser found; set AITEST_CHROMIUM_BIN to an existing Chromium executable");
const browser = await chromium.launch({headless:true,executablePath});
const context = await browser.newContext({viewport:{width:1440,height:1000}});
await context.route("**/*",route=>{const url=new URL(route.request().url()); return url.protocol.startsWith("http") && !["localhost","127.0.0.1","[::1]"].includes(url.hostname) ? route.abort() : route.continue();});
const page = await context.newPage(), errors = [];
page.on("pageerror",error=>errors.push(error.message));
try {
  await page.goto(base); await page.getByRole("menuitem").filter({hasText:"性能测试"}).waitFor();
  for(const label of ["概览","用例库","导入与规范检查","接口测试","接口回归","性能测试","Web UI 测试","App 测试","测试报告","工程化","数据库"]) {
    await page.getByRole("menuitem").filter({hasText:label}).click(); await page.waitForLoadState("networkidle");
    assert((await page.locator(".ant-menu-item-selected").innerText()).includes(label));
  }
  await page.getByRole("menuitem").filter({hasText:"性能测试"}).click();
  await page.getByText("演示预览 · 数据均为合成样本，不是真实压测结果").waitFor();
  await page.emulateMedia({colorScheme:"dark"});await page.waitForFunction(()=>document.documentElement.dataset.theme==="dark");
  await page.emulateMedia({colorScheme:"light"});await page.waitForFunction(()=>document.documentElement.dataset.theme==="light");
  await page.setViewportSize({width:900,height:720});
  const directory = process.env.AITEST_VALIDATION_OUTPUT || "/tmp/aiprobe-architecture-shots";mkdirSync(directory,{recursive:true});
  await page.screenshot({path:`${directory}/browser-preview.png`,animations:"disabled"});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,pages:11,errors,screenshot:`${directory}/browser-preview.png`}));
} finally {await browser.close();}
