import { Alert, Button, Space, Table, Typography } from "antd";
import { useState } from "react";
import { api, type Project, type TestCase } from "../../api";
import { CaseDrawer } from "../../components/CaseLink";
import { RunButton } from "../../components/EnvPicker";
import { notifyProjectChanged, useKeyedAction } from "../../hooks";

export function ApiCaseList({ project, env, rows, onEdit, onChanged }: {
  project: Project; env: string; rows: TestCase[]; onEdit: (c: TestCase) => void; onChanged: () => Promise<void>;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [detailId, setDetailId] = useState<string>();
  const [result, setResult] = useState<{ total: number; passed: number; failed: number; error: number; skipped: number }>();
  const { busy, activeKey, run } = useKeyedAction();
  const detail = rows.find((c) => c.id === detailId);
  const chosen = rows.filter((c) => selected.includes(c.id));
  const reviewable = (c: TestCase) => c.status === "draft" && !c.api_needs_review && c.lint_status !== "blocked";
  const executable = (c: TestCase) => c.status === "reviewed" && !c.api_needs_review && c.lint_status !== "blocked";
  const review = (items: TestCase[]) => run("review", async () => {
    try {
      for (const c of items) await api().updateCase(c.id, { status: "reviewed" });
    } finally {
      notifyProjectChanged(project.id);
      await onChanged();
    }
  }, "审核通过，可批量执行");
  return <>
    <Space wrap className="api-caselist-toolbar">
      <Typography.Text type="secondary">点击用例名称查看步骤、参数与预期；执行选中仅运行确定性接口脚本</Typography.Text>
      <Button disabled={busy || !chosen.length || !chosen.every(reviewable)} loading={activeKey === "review"}
        onClick={() => review(chosen)}>审核选中（{chosen.length}）</Button>
      <RunButton project={project} env={env} loading={activeKey === "run"}
        disabled={busy || !env || !chosen.length || !chosen.every(executable)}
        onRun={(confirmProduction) => run("run", async () => {
          setResult(undefined);
          await api().writeReviewedApiSuite(project.id);
          const out = await api().runRegression(project.id, env, { confirmProduction, caseIds: chosen.map((c) => c.id), autoTriage: false }) as { run: NonNullable<typeof result> };
          setResult(out.run);
          notifyProjectChanged(project.id);
          await onChanged();
        })}>执行选中（{chosen.length}）</RunButton>
    </Space>
    {result && <Alert showIcon className="api-caselist-result" type={result.failed + result.error ? "warning" : "success"}
      message={`执行 ${result.total} 条：通过 ${result.passed}，失败 ${result.failed}，错误 ${result.error}，跳过 ${result.skipped}`}
      description="完整执行记录见测试报告" />}
    <Table size="small" rowKey="id" dataSource={rows} pagination={{ pageSize: 8, hideOnSinglePage: true }}
      rowSelection={{ selectedRowKeys: selected.filter((id) => rows.some((c) => c.id === id)), onChange: (keys) => setSelected(keys.map(String)),
        getCheckboxProps: (c) => ({ disabled: busy || c.status === "deprecated" }) }}
      columns={[
        { title: "用例", dataIndex: "title", render: (title, c) => <Button type="link" className="api-case-link" onClick={() => setDetailId(c.id)}>{title}</Button> },
        { title: "状态", width: 108, render: (_, c) => c.api_needs_review ? "接口待检查" : c.lint_status === "blocked" ? "规范阻断" : c.status === "reviewed" ? "已审核" : c.status === "deprecated" ? "已废弃" : "草稿" },
        { title: "操作", width: 130, render: (_, c) => <Space size={4}>
          <Button size="small" disabled={busy} onClick={() => onEdit(c)}>编辑</Button>
          {reviewable(c) && <Button size="small" disabled={busy} onClick={() => review([c])}>审核</Button>}
        </Space> },
      ]} />
    <CaseDrawer caseId={detail?.id} data={detail} onClose={() => setDetailId(undefined)} extra={(c) =>
      <Button type="primary" disabled={busy || !reviewable(c)} loading={activeKey === "review"} onClick={() => review([c])}>
        {c.status === "reviewed" ? "已审核" : "审核通过"}
      </Button>} />
  </>;
}
