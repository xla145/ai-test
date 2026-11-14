import {
  ApiOutlined,
  CheckCircleFilled,
  CheckOutlined,
  ChromeOutlined,
  CloseOutlined,
  DownOutlined,
  FileExcelOutlined,
  MobileOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  UpOutlined,
} from "@ant-design/icons";
import { Button, Space, Tooltip, Typography } from "antd";
import { useState, type ReactNode } from "react";
import { api, type Project } from "../api";
import { useLoad, useProjectChanged } from "../hooks";
import { visibleProjectTab } from "../projectTypes";
import { useProjects } from "./ProjectSettings";
import { WorkflowGuide } from "./WorkflowGuide";

/** 本机记住的界面状态（关闭、收起）；存储不可用时只在本次会话中生效 */
const store = {
  get(key: string): boolean {
    try {
      return localStorage.getItem(key) === "1";
    } catch {
      return false;
    }
  },
  set(key: string, on: boolean) {
    try {
      if (on) localStorage.setItem(key, "1");
      else localStorage.removeItem(key);
    } catch {
      // 忽略
    }
  },
};
const DISMISS_KEY = (id: string) => `aitest.guide-dismissed.${id}`;
const COLLAPSE_KEY = "aitest.guide-collapsed";

interface Progress {
  cases: number;
  drafts: number;
  reviewed: number;
  runs: number;
}

/** 本次运行中出现过未完成状态的项目：区分「刚完成」与「本来就完成了」。
 *  切换页签时卡片会重新挂载，所以放在组件外 */
const sawIncomplete = new Set<string>();

const STEP_TITLES = ["配置执行环境", "准备用例", "人工审核", "执行回归"];

/**
 * 快速开始：新建项目后按「环境 → 用例 → 审核 → 回归」逐步引导，每步给出直达入口。
 * - 步骤可点击，跳到对应页面；卡片可收起成一行（所有项目共用这个偏好）；
 * - 本次打开时还没完成、随后全部完成的，先显示「已完成」，由用户关闭；
 * - 打开时已经全部完成的项目（老项目）不显示。
 */
export function ProjectGuide({ project }: { project: Project }) {
  const { goTab, openSettings } = useProjects();
  const [dismissed, setDismissed] = useState(() => store.get(DISMISS_KEY(project.id)));
  const [collapsed, setCollapsed] = useState(() => store.get(COLLAPSE_KEY));
  const envCount = Object.keys(project.environments).length;
  const { data, reload } = useLoad<Progress | undefined>(async () => {
    if (store.get(DISMISS_KEY(project.id))) return undefined;
    const count = (status?: string) =>
      api().pageCases(project.id, { page: 1, pageSize: 1, filters: status ? { status } : undefined }).then((r) => r.total);
    const [cases, drafts, reviewed, runs] = await Promise.all([count(), count("draft"), count("reviewed"), api().listRuns(project.id)]);
    return { cases, drafts, reviewed, runs: runs.length };
  }, [project.id]);
  useProjectChanged(project.id, () => void reload());

  if (dismissed || !data) return null;
  const done = [envCount > 0, data.cases > 0, data.reviewed > 0, data.runs > 0];
  const current = done.indexOf(false);
  if (current >= 0) sawIncomplete.add(project.id);
  else if (!sawIncomplete.has(project.id)) return null;

  const dismiss = () => {
    store.set(DISMISS_KEY(project.id), true);
    setDismissed(true);
  };
  const toggle = () => {
    store.set(COLLAPSE_KEY, !collapsed);
    setCollapsed(!collapsed);
  };
  const go = (key: string) => goTab?.(key);
  /** 点击步骤：跳到完成这一步的地方 */
  const openStep = (i: number) => {
    if (i === 0) openSettings?.({ addEnv: !done[0] });
    else go(["import", "cases", "run"][i - 1]);
  };

  const finished = current < 0;
  const actions: ReactNode[] = [
    <Button key="env" type="primary" icon={<PlusOutlined />} onClick={() => openStep(0)}>添加执行环境</Button>,
    <Space key="cases" size={8} wrap>
      <Button type="primary" icon={<FileExcelOutlined />} onClick={() => go("import")}>导入 Excel 用例</Button>
      <Button icon={<ApiOutlined />} onClick={() => go("api")}>从 OpenAPI / 需求文档生成</Button>
    </Space>,
    <Button key="review" type="primary" icon={<CheckOutlined />} onClick={() => go("cases")}>
      {data.drafts ? `去用例库审核（${data.drafts} 条待审）` : "去用例库审核"}
    </Button>,
    <Space key="run" size={8} wrap>
      <Button type="primary" icon={<PlayCircleOutlined />} onClick={() => go("run")}>接口回归</Button>
      {visibleProjectTab("ui", project.project_type) &&
        <Button icon={<ChromeOutlined />} onClick={() => go("ui")}>Web UI 测试</Button>}
      {visibleProjectTab("app", project.project_type) &&
        <Button icon={<MobileOutlined />} onClick={() => go("app")}>App 测试</Button>}
    </Space>,
  ];
  const descriptions = [
    done[0] ? `${envCount} 个环境` : project.parent_id ? "本项目或大项目中添加" : "被测系统的地址",
    done[1] ? `${data.cases} 条用例` : "导入或由 AI 生成",
    done[2] ? `已审 ${data.reviewed} 条` : "通过后才进入回归",
    done[3] ? `已执行 ${data.runs} 次` : "直接跑脚本，不耗模型",
  ];

  const title = (
    <Space size={8}>
      {finished && <CheckCircleFilled style={{ color: "var(--console-success)" }} />}
      快速开始
      <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>{done.filter(Boolean).length}/4</Typography.Text>
    </Space>
  );
  const closeButton = (
    <Tooltip title="不再为这个项目显示">
      <Button size="small" type="text" icon={<CloseOutlined />} aria-label="关闭快速开始" onClick={dismiss} />
    </Tooltip>
  );
  const toggleButton = (
    <Tooltip title={collapsed ? "展开" : "收起"}>
      <Button size="small" type="text" icon={collapsed ? <DownOutlined /> : <UpOutlined />}
        aria-label={collapsed ? "展开快速开始" : "收起快速开始"} onClick={toggle} />
    </Tooltip>
  );

  return (
    <section className={`project-guide ${collapsed ? "is-collapsed" : ""}`} aria-label="项目快速开始">
      <div className="project-guide-heading">
        <div className="project-guide-title">{title}</div>
        {!finished && <span className="project-guide-current">下一步：{STEP_TITLES[current]}</span>}
        <div className="project-guide-controls">{!finished && toggleButton}{closeButton}</div>
      </div>
      {finished ? (
        <div className="project-guide-next">
          <Typography.Text type="secondary">环境、用例、审核、回归都已走通，可在对应测试页面执行日常回归</Typography.Text>
          <Button onClick={dismiss}>知道了</Button>
        </div>
      ) : <>
        {!collapsed && <WorkflowGuide label="项目配置与测试流程" current={current} onStepClick={openStep}
          steps={STEP_TITLES.map((title, i) => ({ title, description: descriptions[i], done: done[i] }))} />}
        <div className="project-guide-next">
          {!collapsed && <Typography.Text type="secondary">{descriptions[current]}</Typography.Text>}
          <div className="project-guide-actions">{actions[current]}</div>
        </div>
      </>}
    </section>
  );
}
