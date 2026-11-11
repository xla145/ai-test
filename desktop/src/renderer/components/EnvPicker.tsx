import { CaretRightOutlined, PlusOutlined, WarningFilled } from "@ant-design/icons";
import { App, Button, Empty, Select, Space, Tag, Typography } from "antd";
import { useEffect, useState, type ReactNode } from "react";
import type { Project } from "../api";
import { useProjects } from "./ProjectSettings";

/** 当前选择的环境：默认取第一个非生产环境；环境被删除或改名后自动回到默认值 */
export function useEnvChoice(project: Project): [string, (env: string) => void] {
  const names = Object.keys(project.environments);
  const fallback = names.find((n) => !project.environments[n].production) ?? names[0] ?? "";
  const [env, setEnv] = useState(fallback);
  const valid = names.includes(env);
  useEffect(() => {
    if (!valid) setEnv(fallback);
  }, [valid, fallback]);
  return [valid ? env : fallback, setEnv];
}

/** 环境下拉：生产环境带红色标记 */
export function EnvSelect({ project, value, onChange, showUrl, width = 220, disabled }: {
  project: Project;
  value: string;
  onChange: (env: string) => void;
  showUrl?: boolean;
  width?: number;
  disabled?: boolean;
}) {
  return (
    <Select value={value} onChange={onChange} disabled={disabled} style={{ width }} popupMatchSelectWidth={false}
      options={Object.entries(project.environments).map(([name, e]) => ({
        value: name,
        label: (
          <Space size={4}>
            {name}
            {e.production && <Tag color="red" bordered={false} style={{ marginInlineEnd: 0 }}>生产</Tag>}
            {showUrl && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{e.base_url}</Typography.Text>}
          </Space>
        ),
      }))} />
  );
}

/**
 * 执行按钮：生产环境显示为危险按钮，点击后二次确认，确认后以 confirmProduction 调用。
 * 主进程同样会拒绝未确认的生产环境执行。
 */
export function RunButton({ project, env, loading, disabled, block, onRun, children }: {
  project: Project;
  env: string;
  loading: boolean;
  disabled?: boolean;
  block?: boolean;
  onRun: (confirmProduction: boolean) => void;
  children: ReactNode;
}) {
  const { modal } = App.useApp();
  const cfg = project.environments[env];
  const production = Boolean(cfg?.production);
  const click = () => {
    if (!production) return onRun(false);
    modal.confirm({
      title: `在生产环境「${env}」上执行？`,
      icon: <WarningFilled style={{ color: "#ff4d4f" }} />,
      content: (
        <>
          <Typography.Paragraph>脚本会向 <Typography.Text code>{cfg?.base_url}</Typography.Text> 发起真实请求，可能创建、修改或删除线上数据。</Typography.Paragraph>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>确认用例只做只读操作，或已获得授权后再继续。</Typography.Paragraph>
        </>
      ),
      okText: "确认在生产环境执行",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: () => onRun(true),
    });
  };
  return (
    <Button type="primary" block={block} danger={production} disabled={disabled} icon={production ? <WarningFilled /> : <CaretRightOutlined />} loading={loading} onClick={click}>
      {production ? <>{children}（生产）</> : children}
    </Button>
  );
}

/** 还没有执行环境时的空状态：直接打开项目设置添加，而不是让用户自己找入口 */
export function NoEnvironment({ project, purpose = "执行回归" }: { project: Project; purpose?: string }) {
  const { openSettings, projects } = useProjects();
  const parent = project.parent_id ? projects.find((p) => p.id === project.parent_id) : undefined;
  return (
    <Empty
      style={{ marginTop: 48 }}
      description={
        <Space direction="vertical" size={4}>
          <Typography.Text>项目还没有配置执行环境</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {parent
              ? `添加被测地址后才能${purpose}；也可以在大项目「${parent.name}」中添加，所有子项目共用`
              : `添加被测地址（如 https://test.example.com）后才能${purpose}`}
          </Typography.Text>
        </Space>
      }
    >
      {openSettings && <Button type="primary" icon={<PlusOutlined />} onClick={() => openSettings({ addEnv: true })}>添加执行环境</Button>}
    </Empty>
  );
}
