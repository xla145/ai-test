import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AssistantMarkdown, safeMarkdownUrl } from "../src/renderer/assistant/AssistantMarkdown";
import { isAssistantSenderUrl } from "../src/main/assistant/ipc";

const render = (content: string) => renderToStaticMarkup(createElement(AssistantMarkdown, { content }));
describe("safe assistant Markdown", () => {
  it("renders headings, lists, emphasis, blockquotes and tables", () => {
    const html = render("## 结论\n\n**先核对环境**\n\n- 登录态\n- 断言\n\n> 非执行结果\n\n| 项目 | 状态 |\n| --- | --- |\n| 报告 | 待核对 |");
    expect(html).toContain("<h2>结论</h2>");
    expect(html).toContain("<strong>先核对环境</strong>");
    expect(html).toContain("<li>登录态</li>");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("<table>");
    expect(html).toContain('aria-label="回复表格"');
  });
  it("renders fenced code as escaped text with a copy action", () => {
    const html = render('```html\n<script>alert(1)</script>\n```');
    expect(html).toContain('aria-label="复制代码"');
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
  it("never loads raw HTML or remote Markdown images", () => {
    const html = render('<script>alert(1)</script>\n\n<iframe src="https://evil.invalid" />\n\n![私有追踪图](https://evil.invalid/pixel)');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("<img");
    expect(html).not.toContain('src="https://evil.invalid');
    expect(html).toContain("私有追踪图");
  });
  it("only offers copying safe external links, never navigating", () => {
    const html = render('[文档](https://example.com/docs) [危险](javascript:alert%281%29)');
    expect(html).toContain("复制链接：https://example.com/docs");
    expect(html).not.toContain("href=");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("危险");
  });
  it.each(["javascript:alert(1)", "file:///etc/passwd", "//evil.invalid", "/local", "data:text/html,x", "https://name:pass@evil.invalid/"])("rejects unsafe link %s", value => {
    expect(safeMarkdownUrl(value)).toBe("");
  });
});

describe("assistant IPC sender URL", () => {
  it("only accepts the configured main renderer", () => {
    expect(isAssistantSenderUrl("file:///app/renderer/index.html", "/app/renderer/index.html")).toBe(true);
    expect(isAssistantSenderUrl("file:///app/other.html", "/app/renderer/index.html")).toBe(false);
    expect(isAssistantSenderUrl("https://other.invalid", "/app/renderer/index.html")).toBe(false);
  });
  it("accepts the configured development origin, not lookalikes or opaque documents", () => {
    expect(isAssistantSenderUrl("http://localhost:5173/?preview", "/unused", "http://localhost:5173")).toBe(true);
    for (const url of ["http://localhost:5174", "http://localhost:5173.evil.invalid", "data:text/html,test", "about:blank"]) {
      expect(isAssistantSenderUrl(url, "/unused", "http://localhost:5173")).toBe(false);
    }
  });
});
