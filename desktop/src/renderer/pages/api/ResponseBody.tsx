import { CopyOutlined, DownloadOutlined } from "@ant-design/icons";
import { App, Button, Pagination, Segmented, Space, Tag, Tooltip, Typography } from "antd";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ApiStepTrace } from "../../../shared/apiWorkspace";
import { JsonTreeView } from "./JsonTreeView";

const PAGE_SIZE = 32 * 1024;

interface ResponseBodyProps {
  response: NonNullable<ApiStepTrace["response"]>;
  onAddAssertion?: (path: string, value: unknown) => void;
  duration_ms?: number;
}

function statusColor(code: number): string {
  if (code >= 200 && code < 300) return "success";
  if (code >= 300 && code < 400) return "processing";
  if (code >= 400 && code < 500) return "warning";
  if (code >= 500) return "error";
  return "default";
}

/** 只限制单页渲染量，复制和下载始终使用完整的脱敏响应。 */
export function ResponseBody({ response, onAddAssertion, duration_ms }: ResponseBodyProps) {
  const { message } = App.useApp();
  const [page, setPage] = useState(1);
  const [view, setView] = useState<"raw" | "tree">("raw");
  const isJson = typeof response.body !== "string" && response.body !== null;
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
    const url = URL.createObjectURL(new Blob([text], { type: isJson ? "application/json;charset=utf-8" : "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = isJson ? "response.json" : "response.txt";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const handleCopyPath = useCallback(async (path: string) => {
    try { await navigator.clipboard.writeText(path); void message.success(`已复制路径: ${path}`); }
    catch { void message.error("复制失败"); }
  }, [message]);
  const handleAddAssertion = useCallback((path: string, value: unknown) => {
    if (onAddAssertion) {
      onAddAssertion(path, value);
      void message.success(`已添加断言: ${path}`);
    }
  }, [onAddAssertion, message]);

  return <div className="api-response-body">
    {/* 状态码 + 耗时摘要 */}
    <div className="api-response-status-bar">
      <Space size={12}>
        <Tag bordered={false} color={statusColor(response.status_code)} className="api-response-status-tag">
          HTTP {response.status_code}
        </Tag>
        {duration_ms !== undefined && <span className="api-mono api-muted">{duration_ms} ms</span>}
        <Typography.Text type="secondary">
          {response.size_bytes === undefined ? `${text.length.toLocaleString()} 字符` : `${(response.size_bytes / 1024).toFixed(1)} KB`}
          {count > 1 ? ` · 分 ${count} 页展示` : ""}
        </Typography.Text>
      </Space>
    </div>

    {response.truncated && <p className="api-muted api-truncated-note">这条历史响应已被旧版本截断或省略，请重新发送请求获取完整内容。</p>}

    {/* 工具栏 */}
    <div className="api-response-tools">
      {isJson && <Segmented size="small" value={view} onChange={(v) => setView(v as "raw" | "tree")}
        options={[{ value: "raw", label: "原始" }, { value: "tree", label: "树形" }]} />}
      <Space>
        <Tooltip title="复制完整响应">
          <Button size="small" icon={<CopyOutlined />} onClick={async () => {
            try { await navigator.clipboard.writeText(text); void message.success("响应已复制"); }
            catch { void message.error("复制失败，请使用下载响应"); }
          }}>{response.truncated ? "复制现有内容" : "复制"}</Button>
        </Tooltip>
        <Tooltip title="下载为文件">
          <Button size="small" icon={<DownloadOutlined />} onClick={download}>下载</Button>
        </Tooltip>
      </Space>
    </div>

    {/* 响应内容 */}
    {view === "tree" && isJson ? (
      <JsonTreeView
        data={response.body}
        onCopyPath={handleCopyPath}
        onAddAssertion={onAddAssertion ? handleAddAssertion : undefined}
      />
    ) : (
      <>
        {count > 1 && <Pagination size="small" current={current} total={text.length} pageSize={PAGE_SIZE} showSizeChanger={false} onChange={setPage} showQuickJumper />}
        <pre className="api-response-code">{text.slice(start, end)}</pre>
      </>
    )}
  </div>;
}
