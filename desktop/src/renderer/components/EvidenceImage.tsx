import { Button, Image, Spin, Tooltip } from "antd";
import { useEffect, useState } from "react";
import { api } from "../api";

/** 截图由主进程读取，避免 HTTP 页面直接访问 file:// 被浏览器拦截。 */
export function EvidenceImage({ projectId, path, width = 64 }: { projectId: string; path: string; width?: number }) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ key: string; src?: string; error?: string }>();
  const key = JSON.stringify([projectId, path, attempt]);
  useEffect(() => {
    let alive = true;
    void api().readEvidenceImage(projectId, path).then(src => {
      if (alive) setState({ key, src });
    }).catch(error => {
      if (alive) setState({ key, error: (error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") });
    });
    return () => { alive = false; };
  }, [projectId, path, key]);
  const current = state?.key === key ? state : undefined;
  if (current?.error) return <Tooltip title={`${current.error}；点击重试`}>
    <Button type="link" size="small" onClick={() => setAttempt(n => n + 1)}>截图加载失败</Button>
  </Tooltip>;
  if (!current?.src) return <Spin size="small" />;
  return <Image width={width} src={current.src} alt="测试证据截图"
    onError={() => setState({ key, error: "截图文件损坏或无法解码" })} />;
}
