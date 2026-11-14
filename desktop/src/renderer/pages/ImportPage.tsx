import { ApiOutlined, CheckCircleOutlined, ReloadOutlined, UploadOutlined } from "@ant-design/icons";
import { Alert, App, Button, Card, Empty, Segmented, Space, Statistic, Table, Typography } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type LintIssue, type Project } from "../api";
import { CaseLink, CaseTitles } from "../components/CaseLink";
import { LabelTag, LEVEL } from "../components/labels";
import { PageHeader } from "../components/PageHeader";
import { useProjects } from "../components/ProjectSettings";
import { useAction, usePaged, useProjectChanged, notifyProjectChanged } from "../hooks";

interface ImportResult {
  imported: number;
  missing_columns?: string[];
  unknown_columns?: string[];
}

const RULE_LABEL: Record<string, string> = {
  required_fields: "必填字段完整",
  steps_expected_mismatch: "步骤与预期数量一致、编号连续",
  conditional_expected: "预期为条件式，结果不唯一",
  expected_is_action: "预期写的是操作而非可判定结果",
  undeclared_test_data: "步骤引用的测试数据未在前置条件声明",
  title_format: "标题不符合「模块-场景」",
  group_not_subdivided: "分组没有细分",
  precondition_duplicates_step: "前置条件含操作且与第 1 步重复",
  p0_ratio: "P0 占比超过阈值",
  category_other: "类型为「其它」",
};

interface LintReport {
  total: number;
  rule_hits: Record<string, number>;
  blocked_case_ids: string[];
  stats: { p0_ratio?: number };
  /** 本次检查时间：结果与上次相同时也触发问题明细重新读取 */
  checkedAt: number;
}

const checked = (r: unknown): LintReport => ({ ...(r as LintReport), checkedAt: Date.now() });

export function ImportPage({ project }: { project: Project }) {
  const [report, setReport] = useState<LintReport>();
  const [checking, setChecking] = useState(true);
  const checkSeq = useRef(0);
  const [level, setLevel] = useState<string>("all");
  const { busy, run } = useAction();
  const { modal, message } = App.useApp();
  const { goTab } = useProjects();
  // 进入页面和项目数据变化后都执行本地规范检查，同步统计与问题明细。
  const refresh = useCallback(async () => {
    const seq = ++checkSeq.current;
    setChecking(true);
    try {
      const result = await api().lint(project.id);
      if (seq === checkSeq.current) setReport(checked(result));
    } catch (e) {
      if (seq === checkSeq.current) message.error(`规范检查失败：${(e as Error).message}`);
    } finally {
      if (seq === checkSeq.current) setChecking(false);
    }
  }, [project.id, message]);
  useEffect(() => {
    setReport(undefined);
    setLevel("all");
    void refresh();
    return () => { checkSeq.current++; };
  }, [refresh]);
  useProjectChanged(project.id, () => { void refresh(); });
  // 问题明细按页从引擎读取；每次检查后 report 变化，回到第 1 页重新读取
  const issues = usePaged<LintIssue>(
    (q) => report
      ? api().pageIssues(project.id, { ...q, level: level === "all" ? undefined : level }) as Promise<{ items: LintIssue[]; total: number; levels?: Record<string, number> }>
      : Promise.resolve({ items: [], total: 0 }),
    [project.id, report, level], 10);
  // 各级别问题数（引擎随每页返回，不受级别筛选影响）
  const counts = issues.levels ?? {};

  const importExcel = () => run(async () => {
    const file = await api().pickFile([{ name: "Excel", extensions: ["xlsx"] }]);
    if (!file) return;
    const out = await api().importExcel(project.id, file) as ImportResult;
    notifyProjectChanged(project.id);
    if (out?.missing_columns?.length) {
      // 列名没对上时整批用例会缺字段并被阻断，明确告诉用户是哪一列
      modal.warning({
        title: `已导入 ${out.imported} 条，但没有找到列：${out.missing_columns.join("、")}`,
        width: 520,
        content: (
          <>
            <p>这些字段会是空的，相关用例会被规范检查阻断。请把 Excel 表头改成下列名称之一后重新导入：</p>
            <ul style={{ paddingInlineStart: 18 }}>
              <li>标题：标题 / 用例标题 / 用例名称</li>
              <li>步骤描述：步骤描述 / 操作步骤 / 测试步骤</li>
              <li>预期结果：预期结果 / 期望结果</li>
              <li>用例等级：用例等级 / 优先级 / 等级</li>
            </ul>
            {out.unknown_columns?.length ? <p>表头中未识别的列：{out.unknown_columns.join("、")}</p> : null}
          </>
        ),
      });
    } else message.success(`导入 ${out?.imported ?? 0} 条，正在自动检查`);
  });

  const recheck = () => { void refresh(); };
  const totalIssues = Object.values(counts).reduce((a, b) => a + b, 0);

  return (
    <>
      <PageHeader
        title="导入与规范检查"
        workflow={[
          { title: "导入 Excel", description: "选择团队已有的 Excel 用例文件" },
          { title: "规范检查", description: "检查结构、步骤、预期和用例等级，不调用模型" },
          { title: "修复阻断", description: "阻断级问题修复前不会生成脚本" },
          { title: "人工审核", description: "在用例库中审核后进入回归" },
        ]}
        description="导入 Excel 后自动检查规范；修复阻断问题并审核后，才能生成回归脚本。"
        extra={<>
          <Button icon={<ReloadOutlined />} loading={checking} disabled={busy} onClick={recheck}>重新检查</Button>
          <Button type="primary" icon={<UploadOutlined />} loading={busy} disabled={checking} onClick={importExcel}>导入 Excel</Button>
        </>}
      />
      {!report || report.total === 0 ? (
        <Card loading={checking}>
          {!report ? (
            <Empty description="未能获取规范检查结果，请重新检查">
              <Button type="primary" icon={<ReloadOutlined />} loading={checking} disabled={busy} onClick={recheck}>重新检查</Button>
            </Empty>
          ) : (
            <Empty description={
              <Space direction="vertical" size={4}>
                <Typography.Text>项目里还没有用例</Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  导入团队已有的 Excel 用例（表头含 标题 / 步骤描述 / 预期结果 / 用例等级），导入后自动检查
                </Typography.Text>
              </Space>
            }>
              <Space wrap style={{ justifyContent: "center" }}>
                <Button type="primary" icon={<UploadOutlined />} loading={busy} disabled={checking} onClick={importExcel}>导入 Excel</Button>
                {goTab && <Button icon={<ApiOutlined />} onClick={() => goTab("api")}>从 OpenAPI / 需求文档生成</Button>}
              </Space>
            </Empty>
          )}
        </Card>
      ) : (
        <>
          <div className="stat-grid metric-strip">
            <Card><Statistic title="用例总数" value={report.total} /></Card>
            <Card><Statistic title="阻断" value={report.blocked_case_ids.length} valueStyle={{ color: report.blocked_case_ids.length ? "var(--console-error)" : undefined }} /></Card>
            <Card><Statistic title="警告" value={counts.warn ?? 0} /></Card>
            <Card><Statistic title="P0 占比" value={((report.stats.p0_ratio ?? 0) * 100).toFixed(1)} suffix="%" /></Card>
          </div>
          {report.blocked_case_ids.length === 0 && (
            <Alert style={{ marginTop: 16 }} type="success" showIcon icon={<CheckCircleOutlined />} message="没有阻断级问题，可以进入脚本生成"
              action={goTab && <Button size="small" onClick={() => goTab("cases")}>去用例库审核</Button>} />
          )}
          <div className="split" style={{ marginTop: 16 }}>
            <div style={{ flex: "2 1 280px" }}>
              <Card title="规则命中" size="small">
                <Table
                  size="small"
                  pagination={false}
                  rowKey="rule"
                  dataSource={Object.entries(report.rule_hits).map(([rule, n]) => ({ rule, n })).sort((a, b) => b.n - a.n)}
                  columns={[
                    { title: "规则", dataIndex: "rule", render: (r: string) => RULE_LABEL[r] ?? r },
                    { title: "用例数", dataIndex: "n", width: 80, align: "right" },
                  ]}
                />
              </Card>
            </div>
            <div style={{ flex: "3 1 420px" }}>
              <Card
                title="问题明细"
                size="small"
                extra={<Segmented size="small" value={level} onChange={(v) => setLevel(String(v))} options={[
                  { label: `全部 ${totalIssues}`, value: "all" },
                  ...["block", "block_script", "warn", "info"].filter((k) => counts[k]).map((k) => ({ label: `${LEVEL[k].text} ${counts[k]}`, value: k })),
                ]} />}
              >
                <CaseTitles projectId={project.id} ids={issues.items.map((i) => i.case_id)}>
                <Table
                  size="small"
                  rowKey="id"
                  scroll={{ x: 520 }}
                  loading={issues.loading}
                  dataSource={issues.items}
                  pagination={{ ...issues.pagination, size: "small" }}
                  columns={[
                    { title: "级别", dataIndex: "level", width: 110, render: (v: string) => <LabelTag map={LEVEL} value={v} /> },
                    { title: "问题", dataIndex: "message", render: (m: string, r: LintIssue) => (
                      <>{m}<div style={{ marginTop: 4 }}><CaseLink id={r.case_id} /></div></>
                    ) },
                    { title: "修改建议", dataIndex: "suggestion", width: "38%" },
                  ]}
                />
                </CaseTitles>
              </Card>
            </div>
          </div>
        </>
      )}
    </>
  );
}
