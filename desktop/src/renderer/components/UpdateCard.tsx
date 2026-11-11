import { CheckCircleFilled, CloudDownloadOutlined, ReloadOutlined, SyncOutlined, WarningFilled } from "@ant-design/icons";
import { Button, Card, Progress, Space, Switch, Typography } from "antd";
import { useEffect, useState } from "react";
import type { GlobalSettings, UpdateState } from "../../shared/ipc";
import { api } from "../api";
import { useAction } from "../hooks";

/** 当前更新状态：订阅主进程推送 */
export function useUpdateState(): UpdateState | undefined {
  const [state, setState] = useState<UpdateState>();
  useEffect(() => {
    api().getUpdateState().then(setState, () => undefined);
    return api().onUpdate(setState);
  }, []);
  return state;
}

const STATUS_TEXT: Record<UpdateState["status"], string> = {
  disabled: "未启用",
  idle: "尚未检查",
  checking: "正在检查…",
  "not-available": "已是最新版本",
  available: "发现新版本",
  downloading: "正在后台下载新版本",
  downloaded: "新版本已下载，重启后完成更新",
  error: "检查或下载失败",
};

/** 全局设置中的「软件更新」：版本、状态、手动检查、重启并更新、自动检查开关 */
export function UpdateCard({ settings, onSave }: { settings: GlobalSettings; onSave: (s: GlobalSettings) => Promise<unknown> }) {
  const state = useUpdateState();
  const { busy, run } = useAction();
  if (!state) return <Card size="small" title="软件更新" loading />;
  const icon = state.status === "downloaded" || state.status === "not-available"
    ? <CheckCircleFilled style={{ color: "#52c41a" }} />
    : state.status === "error" ? <WarningFilled style={{ color: "#faad14" }} />
      : state.status === "checking" || state.status === "downloading" ? <SyncOutlined spin /> : null;

  return (
    <Card size="small" title="软件更新" style={{ marginBottom: 16 }}
      extra={state.status !== "disabled" && (
        <Space size={6}>
          <Typography.Text type="secondary">自动检查</Typography.Text>
          <Switch size="small" checked={settings.general.autoUpdate !== false} disabled={busy}
            onChange={(v) => run(() => onSave({ ...settings, general: { ...settings.general, autoUpdate: v } }))} />
        </Space>
      )}>
      <Space direction="vertical" style={{ width: "100%" }}>
        <Space wrap>
          <Typography.Text>当前版本 <Typography.Text strong>{state.current}</Typography.Text></Typography.Text>
          {state.version && state.version !== state.current && <Typography.Text>→ 新版本 <Typography.Text strong>{state.version}</Typography.Text></Typography.Text>}
        </Space>
        <Space>
          {icon}
          <Typography.Text type={state.status === "error" ? "danger" : undefined}>
            {state.status === "disabled" ? `未启用：${state.reason}` : STATUS_TEXT[state.status]}
          </Typography.Text>
          {state.checkedAt && <Typography.Text type="secondary" style={{ fontSize: 12 }}>（{new Date(state.checkedAt).toLocaleString()}）</Typography.Text>}
        </Space>
        {state.status === "downloading" && <Progress percent={state.progress ?? 0} size="small" />}
        {state.error && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{state.error}</Typography.Text>}
        {state.status !== "disabled" && (
          <Space wrap>
            {state.status === "downloaded" ? (
              <Button type="primary" icon={<ReloadOutlined />} loading={busy} onClick={() => run(() => api().installUpdate())}>重启并更新</Button>
            ) : (
              <Button icon={<CloudDownloadOutlined />} loading={busy || state.status === "checking"}
                disabled={state.status === "downloading"} onClick={() => run(() => api().checkForUpdates())}>检查更新</Button>
            )}
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              有新版本时自动在后台下载，不会打断正在进行的测试；点「重启并更新」后安装并重新打开。
            </Typography.Text>
          </Space>
        )}
      </Space>
    </Card>
  );
}
