import { ApiOutlined, ChromeOutlined, CloseOutlined, FileExcelOutlined, PlayCircleOutlined, PlusOutlined, CheckOutlined } from "@ant-design/icons";
import { Button, Card, Space, Steps, Tooltip, Typography } from "antd";
import { useState, type ReactNode } from "react";
import { api, type Project } from "../api";
import { useLoad, useNarrow, useProjectChanged } from "../hooks";
import { useProjects } from "./ProjectSettings";

const DISMISS_KEY = (id: string) => `aitest.guide-dismissed.${id}`;

function readDismissed(id: string): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY(id)) === "1";
  } catch {
    return false;
  }
}

function writeDismissed(id: string) {
  try {
    localStorage.setItem(DISMISS_KEY(id), "1");
  } catch {
    // 存储不可用时只在本次会话中隐藏
  }
}

interface Progress {
  cases: number;
  reviewed: number;
  runs: number;
}

/**
 * 快速开始：新建项目后按「环境 → 用例 → 审核 → 回归」逐步引导，每步给出直达入口。
 * 全部完成或用户关闭后不再显示；每次切换页签时重新读取进度。
 */
export function ProjectGuide({ project }: { project: Project }) {
  const { goTab, openSettings } = useProjects();
  const [dismissed, setDismissed] = useState(() => readDismissed(project.id));
  const [ref, narrow] = useNarrow<HTMLDivElement>(680);
  const envCount = Object.keys(project.environments).length;
  const { data, reload } = useLoad<Progress | undefined>(async () => {
    if (readDismissed(project.id)) return undefined;
    const [all, reviewed, runs] = await Promise.all([
      api().pageCases(project.id, { page: 1, pageSize: 1 }),
      api().pageCases(project.id, { page: 1, pageSize: 1, filters: { status: "reviewed" } }),
      api().listRuns(project.id),
    ]);
    return { cases: all.total, reviewed: reviewed.total, runs: runs.length };
  }, [project.id]);
  useProjectChanged(project.id, () => void reload());

  if (dismissed || !data) return null;
  const done = [envCount > 0, data.cases > 0, data.reviewed > 0, data.runs > 0];
  const current = done.indexOf(false);
  if (current < 0) return null;

  const go = (key: string) => goTab?.(key);
  const actions: ReactNode[] = [
    <Button key="env" size="small" type="primary" icon={<PlusOutlined />} onClick={() => openSettings?.({ addEnv: true })}>添加执行环境</Button>,
    <Space key="cases" size={8} wrap>
      <Button size="small" type="primary" icon={<FileExcelOutlined />} onClick={() => go("import")}>导入 Excel 用例</Button>
      <Button size="small" icon={<ApiOutlined />} onClick={() => go("api")}>从 OpenAPI / 需求文档生成</Button>
    </Space>,
    <Button key="review" size="small" type="primary" icon={<CheckOutlined />} onClick={() => go("cases")}>
      去用例库审核（{data.cases} 条待审）
    </Button>,
    <Space key="run" size={8} wrap>
      <Button size="small" type="primary" icon={<PlayCircleOutlined />} onClick={() => go("run")}>接口回归</Button>
      <Button size="small" icon={<ChromeOutlined />} onClick={() => go("ui")}>UI 测试</Button>
    </Space>,
  ];
  const isChild = Boolean(project.parent_id);
  const items = [
    { title: "配置执行环境", description: done[0] ? `${envCount} 个环境` : isChild ? "被测地址，可在本项目或大项目中添加" : "被测系统的地址" },
    { title: "准备用例", description: done[1] ? `${data.cases} 条用例` : "导入已有用例，或让 AI 生成" },
    { title: "人工审核", description: done[2] ? `已审 ${data.reviewed} 条` : "审核通过的用例才进入回归" },
    { title: "执行回归", description: done[3] ? `${data.runs} 次执行` : "直接执行脚本，不耗模型" },
  ];

  return (
    <div ref={ref}>
      <Card size="small" style={{ marginBottom: 16 }}
        title={<Space size={8}>快速开始<Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>{done.filter(Boolean).length}/4</Typography.Text></Space>}
        extra={(
          <Tooltip title="不再为这个项目显示">
            <Button size="small" type="text" icon={<CloseOutlined />} aria-label="关闭快速开始"
              onClick={() => { writeDismissed(project.id); setDismissed(true); }} />
          </Tooltip>
        )}>
        <Steps size="small" current={current} direction={narrow ? "vertical" : "horizontal"}
          items={items.map((it, i) => ({ ...it, status: done[i] ? "finish" : i === current ? "process" : "wait" }))} />
        <Space style={{ marginTop: 12 }} size={8} wrap>
          <Typography.Text type="secondary">下一步：</Typography.Text>
          {actions[current]}
        </Space>
      </Card>
    </div>
  );
}
