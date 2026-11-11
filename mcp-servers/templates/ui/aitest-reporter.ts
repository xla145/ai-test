import type { Reporter, TestCase, TestStep } from "@playwright/test/reporter";
/** 生成脚本中每步包在 test.step("[S3] …") 里，向上找到它就能把 API 调用归到脚本步骤 */
function stepId(step: TestStep | undefined): string | undefined {
  for (let s = step; s; s = s.parent) {
    const id = s.category === "test.step" ? s.title.match(/^\[(S\d+|[A-Za-z][\w-]{0,31})\]/)?.[1] : undefined;
    if (id) return id;
  }
  return undefined;
}
export default class LiveReporter implements Reporter {
  onStdOut(chunk: string | Buffer) {
    // Playwright worker 的 stdout 先进入 reporter，再转发给桌面端。
    for (const line of chunk.toString().split("\n")) if (line.startsWith("AITEST_STEP:")) process.stdout.write(`${line}\n`);
  }
  onStepBegin(test: TestCase, _result: unknown, step: TestStep) { this.send(test, step, "running"); }
  onStepEnd(test: TestCase, _result: unknown, step: TestStep) { this.send(test, step, step.error ? "failed" : "passed"); }
  private send(test: TestCase, step: TestStep, status: string) {
    if (step.category !== "pw:api" && step.category !== "test.step") return;
    const id = stepId(step);
    process.stdout.write(`AITEST_STEP:${JSON.stringify({ caseId: test.title.match(/^(tc_[\w-]+)/)?.[1], title: step.title, status,
      ...(id ? { stepId: id, kind: step.category === "test.step" ? "step" : "api" } : {}),
      ...(step.error?.message && step.category === "test.step" ? { error: step.error.message.replace(/\u001b\[[0-9;]*m/g, "").slice(0, 1000) } : {}) })}\n`);
  }
}
