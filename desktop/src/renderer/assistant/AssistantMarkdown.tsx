import { CheckOutlined, CopyOutlined, LinkOutlined } from "@ant-design/icons";
import React, { Children, isValidElement, useEffect, useRef, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./AssistantMarkdown.css";

export function safeMarkdownUrl(value: string): string {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : "";
  } catch { return ""; }
}
function textOf(node: ReactNode): string {
  return Children.toArray(node).map(child => typeof child === "string" || typeof child === "number" ? String(child)
    : isValidElement<{ children?: ReactNode }>(child) ? textOf(child.props.children) : "").join("");
}
function CopyButton({ text, link = false, children }: { text: string; link?: boolean; children?: ReactNode }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setState("copied"); }
    catch { setState("failed"); }
    clearTimeout(timer.current); timer.current = setTimeout(() => setState("idle"), 2000);
  };
  return <button type="button" className={link ? "assistant-markdown-link" : "assistant-code-copy"}
    title={link ? `复制链接：${text}` : "复制代码"} aria-label={link ? `复制链接：${text}` : "复制代码"} onClick={() => void copy()}>
    {children}{state === "copied" ? <CheckOutlined /> : link ? <LinkOutlined /> : <CopyOutlined />}
    <span aria-live="polite">{state === "copied" ? "已复制" : state === "failed" ? "复制失败，请手动选择" : link ? "" : "复制"}</span>
  </button>;
}
function CodeBlock({ children }: { children?: ReactNode }) {
  const code = Children.toArray(children).find(child => isValidElement(child));
  const language = isValidElement<{ className?: string }>(code) ? code.props.className?.replace(/^language-/, "") : undefined;
  return <div className="assistant-code-block">
    <div className="assistant-code-header"><span>{language || "代码"}</span><CopyButton text={textOf(children).replace(/\n$/, "")} /></div>
    <pre tabIndex={0} aria-label="代码内容">{children}</pre>
  </div>;
}

/** Untrusted model output never becomes HTML, a remote image request or an automatic navigation. */
export function AssistantMarkdown({ content }: { content: string }) {
  return <div className="assistant-markdown"><Markdown skipHtml remarkPlugins={[remarkGfm]}
    urlTransform={safeMarkdownUrl} components={{
      a: ({ href, children }) => href ? <CopyButton text={href} link>{children}</CopyButton> : <span>{children}</span>,
      img: ({ alt }) => <span className="assistant-markdown-image">[图片：{alt || "未加载外部图片"}]</span>,
      pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
      table: ({ children }) => <div className="assistant-table-scroll" tabIndex={0} role="region" aria-label="回复表格"><table>{children}</table></div>,
    }}>{content}</Markdown></div>;
}
