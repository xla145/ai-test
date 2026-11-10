import { CheckOutlined, FileExcelOutlined, SearchOutlined, StopOutlined } from "@ant-design/icons";
import { Button, Card, Descriptions, Drawer, Flex, Input, Popconfirm, Select, Space, Table, Tag, Typography } from "antd";
import { useMemo, useState } from "react";
import { api, type Project, type TestCase } from "../api";
import { LabelTag, LINT, MODE, STATUS } from "../components/labels";
import { PageHeader } from "../components/PageHeader";
import { useAction, useLoad } from "../hooks";

const PRIORITY_COLOR: Record<string, string> = { P0: "red", P1: "orange", P2: "blue", P3: "default" };

export function CasesPage({ project }: { project: Project }) {
  const { data: cases = [], loading, reload } = useLoad(() => api().listCases(project.id) as Promise<TestCase[]>, [project.id]);
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<{ mode?: string; priority?: string; status?: string; lint?: string }>({});
  const [selected, setSelected] = useState<string[]>([]);
  const [detail, setDetail] = useState<TestCase>();
  const { busy, run } = useAction();

  const rows = useMemo(() => cases.filter((c) =>
    (!query || c.title.includes(query) || c.id.includes(query) || c.module_path.join("/").includes(query)) &&
    (!filters.mode || c.execution_mode === filters.mode) &&
    (!filters.priority || c.priority === filters.priority) &&
    (!filters.status || c.status === filters.status) &&
    (!filters.lint || c.lint_status === filters.lint)), [cases, query, filters]);

  const setStatus = (ids: string[], status: string) => run(async () => {
    for (const id of ids) await api().updateCase(id, { status }, "human");
    setSelected([]);
    await reload();
  }, `已更新 ${ids.length} 条用例`);

  const options = (map: Record<string, { text: string }>) => Object.entries(map).map(([value, v]) => ({ value, label: v.text }));

  return (
    <>
      <PageHeader title="用例库" description={`共 ${cases.length} 条。用例需人工审核后才进入回归；有阻断问题的用例不会生成脚本。`}
        extra={<Button icon={<FileExcelOutlined />} loading={busy}
          onClick={() => run(async () => {
            const out = await api().exportCasesExcel(project.id, project.name);
            if (out) await api().showInFolder(out.path).catch(() => undefined);
          })}>导出 Excel</Button>} />
      <Card size="small" style={{ marginBottom: 12 }}>
        <Flex gap={8} wrap align="center">
          <Input allowClear prefix={<SearchOutlined />} placeholder="搜索标题、模块或用例 ID" style={{ width: 260 }}
            value={query} onChange={(e) => setQuery(e.target.value)} />
          <Select allowClear placeholder="执行方式" style={{ width: 120 }} options={options(MODE)} value={filters.mode} onChange={(v) => setFilters({ ...filters, mode: v })} />
          <Select allowClear placeholder="等级" style={{ width: 100 }} options={["P0", "P1", "P2", "P3"].map((p) => ({ value: p, label: p }))} value={filters.priority} onChange={(v) => setFilters({ ...filters, priority: v })} />
          <Select allowClear placeholder="审核状态" style={{ width: 110 }} options={options(STATUS)} value={filters.status} onChange={(v) => setFilters({ ...filters, status: v })} />
          <Select allowClear placeholder="规范检查" style={{ width: 110 }} options={options(LINT)} value={filters.lint} onChange={(v) => setFilters({ ...filters, lint: v })} />
          <div style={{ flex: 1 }} />
          {selected.length > 0 && (
            <Space>
              <Typography.Text type="secondary">已选 {selected.length} 条</Typography.Text>
              <Button type="primary" icon={<CheckOutlined />} loading={busy} onClick={() => setStatus(selected, "reviewed")}>审核通过</Button>
              <Popconfirm title="确定废弃选中的用例？" onConfirm={() => setStatus(selected, "deprecated")}>
                <Button danger icon={<StopOutlined />} loading={busy}>废弃</Button>
              </Popconfirm>
            </Space>
          )}
        </Flex>
      </Card>
      <Table
        size="middle"
        rowKey="id"
        loading={loading}
        dataSource={rows}
        rowSelection={{ selectedRowKeys: selected, onChange: (k) => setSelected(k as string[]) }}
        pagination={{ pageSize: 20, showTotal: (t) => `${t} 条` }}
        onRow={(r) => ({ onDoubleClick: () => setDetail(r) })}
        columns={[
          { title: "标题", dataIndex: "title", render: (t: string, r: TestCase) => (
            <a onClick={() => setDetail(r)}>{t}<div><Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.module_path.join(" / ")}</Typography.Text></div></a>
          ) },
          { title: "等级", dataIndex: "priority", width: 80, sorter: (a, b) => a.priority.localeCompare(b.priority),
            render: (p: string) => <Tag color={PRIORITY_COLOR[p]} bordered={false}>{p}</Tag> },
          { title: "执行方式", dataIndex: "execution_mode", width: 110, render: (v: string) => <LabelTag map={MODE} value={v} /> },
          { title: "规范检查", dataIndex: "lint_status", width: 100, render: (v: string) => <LabelTag map={LINT} value={v} /> },
          { title: "状态", dataIndex: "status", width: 80, render: (v: string) => <LabelTag map={STATUS} value={v} /> },
          { title: "", width: 100, render: (_: unknown, r: TestCase) => r.status === "draft" && (
            <Button size="small" type="link" disabled={busy || r.lint_status === "blocked"} onClick={() => setStatus([r.id], "reviewed")}>审核通过</Button>
          ) },
        ]}
      />
      <Drawer open={!!detail} onClose={() => setDetail(undefined)} width={560} title={detail?.title}
        extra={detail?.status === "draft" && <Button type="primary" onClick={() => detail && setStatus([detail.id], "reviewed").then(() => setDetail(undefined))}>审核通过</Button>}>
        {detail && (
          <>
            <Descriptions size="small" column={2} items={[
              { key: "id", label: "用例 ID", children: <span className="mono">{detail.id}</span>, span: 2 },
              { key: "m", label: "模块", children: detail.module_path.join(" / ") || "—", span: 2 },
              { key: "p", label: "等级", children: <Tag color={PRIORITY_COLOR[detail.priority]} bordered={false}>{detail.priority}</Tag> },
              { key: "c", label: "类型", children: detail.category },
              { key: "e", label: "执行方式", children: <LabelTag map={MODE} value={detail.execution_mode} /> },
              { key: "s", label: "状态", children: <><LabelTag map={STATUS} value={detail.status} /><LabelTag map={LINT} value={detail.lint_status} /></> },
              ...(detail.data_refs?.length ? [{ key: "d", label: "测试数据", children: detail.data_refs.map((d) => <Tag key={d}>{d}</Tag>), span: 2 }] : []),
            ]} />
            {detail.preconditions.length > 0 && (
              <>
                <Typography.Title level={5} style={{ marginTop: 16 }}>前置条件</Typography.Title>
                <ol className="case-steps">{detail.preconditions.map((p, i) => <li key={i}>{p}</li>)}</ol>
              </>
            )}
            <Typography.Title level={5} style={{ marginTop: 16 }}>步骤与预期</Typography.Title>
            <Table size="small" pagination={false} rowKey="i"
              dataSource={detail.steps.map((s, i) => ({ i: i + 1, s, e: detail.expected[i] ?? "" }))}
              columns={[{ title: "#", dataIndex: "i", width: 40 }, { title: "步骤", dataIndex: "s" }, { title: "预期结果", dataIndex: "e" }]} />
          </>
        )}
      </Drawer>
    </>
  );
}
