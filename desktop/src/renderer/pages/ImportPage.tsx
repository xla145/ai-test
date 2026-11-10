import { CheckCircleOutlined, ReloadOutlined, UploadOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Col, Empty, Row, Segmented, Statistic, Table, Typography } from "antd";
import { useState } from "react";
import { api, type LintIssue, type Project } from "../api";
import { LabelTag, LEVEL } from "../components/labels";
import { PageHeader } from "../components/PageHeader";
import { useAction, usePaged } from "../hooks";

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
  const [level, setLevel] = useState<string>("all");
  const { busy, run } = useAction();
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
    await api().importExcel(project.id, file);
    setReport(checked(await api().lint(project.id)));
  }, "导入完成，已完成规范检查");

  const totalIssues = Object.values(counts).reduce((a, b) => a + b, 0);

  return (
    <>
      <PageHeader
        title="用例导入与规范检查"
        description="导入团队已有的 Excel 用例。结构类规则由代码检查、不耗模型；阻断级问题修复前不会生成脚本。"
        extra={<>
          <Button icon={<ReloadOutlined />} loading={busy} onClick={() => run(async () => setReport(checked(await api().lint(project.id))))}>重新检查</Button>
          <Button type="primary" icon={<UploadOutlined />} loading={busy} onClick={importExcel}>导入 Excel</Button>
        </>}
      />
      {!report ? (
        <Card><Empty description="导入 Excel 或点击「重新检查」查看规范检查结果" /></Card>
      ) : (
        <>
          <Row gutter={16}>
            <Col span={6}><Card><Statistic title="用例总数" value={report.total} /></Card></Col>
            <Col span={6}><Card><Statistic title="阻断" value={report.blocked_case_ids.length} valueStyle={{ color: report.blocked_case_ids.length ? "#cf1322" : undefined }} /></Card></Col>
            <Col span={6}><Card><Statistic title="警告" value={counts.warn ?? 0} /></Card></Col>
            <Col span={6}><Card><Statistic title="P0 占比" value={((report.stats.p0_ratio ?? 0) * 100).toFixed(1)} suffix="%" /></Card></Col>
          </Row>
          {report.blocked_case_ids.length === 0 && (
            <Alert style={{ marginTop: 16 }} type="success" showIcon icon={<CheckCircleOutlined />} message="没有阻断级问题，可以进入脚本生成" />
          )}
          <Row gutter={16} style={{ marginTop: 16 }}>
            <Col span={9}>
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
            </Col>
            <Col span={15}>
              <Card
                title="问题明细"
                size="small"
                extra={<Segmented size="small" value={level} onChange={(v) => setLevel(String(v))} options={[
                  { label: `全部 ${totalIssues}`, value: "all" },
                  ...["block", "block_script", "warn", "info"].filter((k) => counts[k]).map((k) => ({ label: `${LEVEL[k].text} ${counts[k]}`, value: k })),
                ]} />}
              >
                <Table
                  size="small"
                  rowKey="id"
                  loading={issues.loading}
                  dataSource={issues.items}
                  pagination={{ ...issues.pagination, size: "small" }}
                  columns={[
                    { title: "级别", dataIndex: "level", width: 110, render: (v: string) => <LabelTag map={LEVEL} value={v} /> },
                    { title: "问题", dataIndex: "message", render: (m: string, r: LintIssue) => (
                      <>{m}<div><Typography.Text type="secondary" className="mono">{r.case_id}</Typography.Text></div></>
                    ) },
                    { title: "修改建议", dataIndex: "suggestion", width: "38%" },
                  ]}
                />
              </Card>
            </Col>
          </Row>
        </>
      )}
    </>
  );
}
