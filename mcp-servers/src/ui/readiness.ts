import type { Page, Request } from 'playwright-core';

/** Observe data requests and visible loading indicators; no business text or model calls. */
export class UiReadiness {
  private pending = new Set<Request>();
  private changedAt = Date.now();
  private failure?: string;
  constructor(private page: Page) {
    page.on('request', request => {
      if (!['document', 'xhr', 'fetch'].includes(request.resourceType())) return;
      this.pending.add(request); this.changedAt = Date.now();
    });
    const finish = (request: Request) => {
      if (this.pending.delete(request)) this.changedAt = Date.now();
    };
    page.on('requestfinished', finish);
    page.on('requestfailed', finish);
    page.on('response', response => {
      if (!this.pending.has(response.request()) || ![502, 503, 504].includes(response.status())) return;
      const url = new URL(response.url());
      this.failure = `UI_ENVIRONMENT_BLOCKED: ${response.request().method()} ${url.origin}${url.pathname} 返回 ${response.status()}；不能使用旧结果继续断言`;
    });
  }
  async wait(timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    let quietSince = Date.now();
    while (Date.now() < deadline) {
      if (this.failure) throw new Error(this.failure);
      const busy = await this.page.evaluate(() => [...document.querySelectorAll('[aria-busy="true"],.el-loading-mask,.ant-spin-spinning,.el-loading-spinner')].some(el => {
        const style = getComputedStyle(el);
        return el.getClientRects().length > 0 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0;
      }));
      if (busy || this.pending.size) quietSince = Date.now();
      if (!busy && !this.pending.size && Date.now() - Math.max(quietSince, this.changedAt) >= 300) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('UI_RESULT_NOT_READY: 数据请求或可见加载状态未结束，不能把当前列表当作最终结果');
  }
}
