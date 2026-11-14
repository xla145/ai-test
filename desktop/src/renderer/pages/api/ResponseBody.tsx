import { App, Button, Pagination, Space, Typography } from "antd";
import { useEffect, useMemo, useState } from "react";
import type { ApiStepTrace } from "../../../shared/apiWorkspace";

const PAGE_SIZE = 32 * 1024;

/** 只限制单页渲染量，复制和下载始终使用完整的脱敏响应。 */
export function ResponseBody({ response }: { response: NonNullable<ApiStepTrace["response"]> }) {
  const { message } = App.useApp();
  const [page, setPage] = useState(1);
  const text = useMemo(() => typeof response.body === "string" ? response.body : JSON.stringify(response.body, null, 2) ?? "", [response.body]);
  useEffect(() => { setPage(1); }, [text]);
  const count = Math.max(1, Math.ceil(text.length / PAGE_SIZE));
  const current = Math.min(page, count);
  let start = (current - 1) * PAGE_SIZE;
  let end = current * PAGE_SIZE;
  // 分页不能把 UTF-16 代理对拆开，避免表情等字符显示成乱码。
  if (start && /[\uDC00-\uDFFF]/.test(text[start]) && /[\uD800-\uDBFF]/.test(text[start - 1])) start++;
  if (/[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end++;
  const download = () => {
    const isJson = typeof response.body !== "string";
    const url = URL.createObjectURL(new Blob([text], { type: isJson ? "application/json;charset=utf-8" : "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = isJson ? "response.json" : "response.txt";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <div>
    {response.truncated && <p className="api-muted">这条历史响应已被旧版本截断或省略，请重新发送请求获取完整内容。</p>}
    <div className="api-response-tools">
      <Typography.Text type="secondary">{response.size_bytes === undefined ? `${text.length.toLocaleString()} 字符` : `${(response.size_bytes / 1024).toFixed(1)} KB`}{count > 1 ? ` · 分 ${count} 页展示，内容完整保留` : ""}</Typography.Text>
      <Space>
        <Button size="small" onClick={async () => {
          try { await navigator.clipboard.writeText(text); void message.success("响应已复制"); }
          catch { void message.error("复制失败，请使用下载响应"); }
        }}>复制{response.truncated ? "现有内容" : "完整响应"}</Button>
        <Button size="small" onClick={download}>下载响应</Button>
      </Space>
    </div>
    {count > 1 && <Pagination size="small" current={current} total={text.length} pageSize={PAGE_SIZE} showSizeChanger={false} onChange={setPage} showQuickJumper />}
    <pre className="api-response-code">{text.slice(start, end)}</pre>
  </div>;
}
