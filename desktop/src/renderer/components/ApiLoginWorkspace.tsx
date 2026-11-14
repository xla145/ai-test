import { Button, Splitter, Typography } from "antd";
import { useState } from "react";
import type { Project } from "../api";
import { ApiBrowserLogin } from "./ApiBrowserLogin";
import { BrowserDock } from "./BrowserDock";

const WIDTH_KEY = "aitest:api-login-panel-width";
const DEFAULT_WIDTH = 35;

export function ApiLoginWorkspace({ project, env, onProtocol }: { project: Project; env: string; onProtocol: () => void }) {
  const [width, setWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(WIDTH_KEY));
      if (Number.isFinite(saved) && saved >= 20 && saved <= 65) return saved;
    } catch { /* 使用默认宽度 */ }
    return DEFAULT_WIDTH;
  });
  const [resizing, setResizing] = useState(false);
  const remember = (next: number) => {
    setWidth(next);
    try { localStorage.setItem(WIDTH_KEY, String(next)); } catch { /* 存储不可用时仍可调整 */ }
  };
  const resize = (sizes: number[]) => {
    const total = sizes.reduce((sum, size) => sum + size, 0);
    if (total) setWidth(sizes[0] / total * 100);
  };
  return <div className="api-login-workspace">
    <div className="api-login-layout-tools">
      <Typography.Text type="secondary">拖动中间分隔线调整浏览器宽度</Typography.Text>
      <Button size="small" type="text" onClick={() => remember(DEFAULT_WIDTH)}>恢复默认宽度</Button>
    </div>
    <Splitter className="api-login-splitter" onResizeStart={() => setResizing(true)} onResize={resize} onResizeEnd={(sizes) => {
      setResizing(false);
      const total = sizes.reduce((sum, size) => sum + size, 0);
      if (total) remember(sizes[0] / total * 100);
    }}>
      <Splitter.Panel size={`${width}%`} min="20%" max="65%">
        <div className="api-login-settings">
          <ApiBrowserLogin key={`${project.id}:${env}`} project={project} env={env} />
          <Button onClick={onProtocol}>配置接口登录与加密</Button>
        </div>
      </Splitter.Panel>
      <Splitter.Panel min="35%">
        <BrowserDock title="登录浏览器" suspended={resizing} />
      </Splitter.Panel>
    </Splitter>
  </div>;
}
