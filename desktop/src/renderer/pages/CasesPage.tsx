import { CheckOutlined, FileExcelOutlined, SearchOutlined, StopOutlined } from "@ant-design/icons";
import { Button, Card, Flex, Input, Popconfirm, Select, Space, Table, Tag, Typography } from "antd";
import { useState } from "react";
import { api, type Project, type TestCase } from "../api";
import { CaseDrawer, PRIORITY_COLOR } from "../components/CaseLink";
import { LabelTag, LINT, MODE, STATUS } from "../components/labels";
import { PageHeader } from "../components/PageHeader";
import { useAction, useDebounced, usePaged } from "../hooks";


export function CasesPage({ project }: { project: Project }) {
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<{ mode?: string; priority?: string; status?: string; lint?: string }>({});
  const [selected, setSelected] = useState<string[]>([]);
  const [detail, setDetail] = useState<TestCase>();
  const { busy, run } = useAction();
  const q = useDebounced(query.trim());
  // 搜索与筛选在引擎端执行，按页读取
  const { items: rows, loading, reload, pagination } = usePaged<TestCase>(
    (page) => api().pageCases(project.id, {
      ...page, query: q || undefined,
      filters: { execution_mode: filters.mode, priority: filters.priority, status: filters.status, lint_status: filters.lint },
    }) as Promise<{ items: TestCase[]; total: number }>,
    [project.id, q, filters],
  );

  const setStatus = (ids: string[], status: string) => run(async () => {
    for (const id of ids) await api().updateCase(id, { status }, "human");
    setSelected([]);
    await reload();
  }, `已更新 ${ids.length} 条用例`);

  const options = (map: Record<string, { text: string }>) => Object.entries(map).map(([value, v]) => ({ value, label: v.text }));

  return (
    <>
      <PageHeader title="用例库" description="用例需人工审核后才进入回归；有阻断问题的用例不会生成脚本。"
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
        scroll={{ x: 760 }}
        // 翻页后保留其它页已选的用例，可跨页批量审核
        rowSelection={{ selectedRowKeys: selected, preserveSelectedRowKeys: true, onChange: (k) => setSelected(k as string[]) }}
        pagination={pagination}
        onRow={(r) => ({ onDoubleClick: () => setDetail(r) })}
        columns={[
          { title: "标题", dataIndex: "title", width: 280, render: (t: string, r: TestCase) => (
            <a onClick={() => setDetail(r)}>{t?.trim() || "未填写标题"}<div><Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.module_path.join(" / ")}</Typography.Text></div></a>
          ) },
          { title: "等级", dataIndex: "priority", width: 80,
            render: (p: string) => <Tag color={PRIORITY_COLOR[p]} bordered={false}>{p}</Tag> },
          { title: "执行方式", dataIndex: "execution_mode", width: 110, render: (v: string) => <LabelTag map={MODE} value={v} /> },
          { title: "规范检查", dataIndex: "lint_status", width: 100, render: (v: string) => <LabelTag map={LINT} value={v} /> },
          { title: "状态", dataIndex: "status", width: 80, render: (v: string) => <LabelTag map={STATUS} value={v} /> },
          { title: "", width: 100, render: (_: unknown, r: TestCase) => r.status === "draft" && (
            <Button size="small" type="link" disabled={busy || r.lint_status === "blocked"} onClick={() => setStatus([r.id], "reviewed")}>审核通过</Button>
          ) },
        ]}
      />
      <CaseDrawer caseId={detail?.id} data={detail} onClose={() => setDetail(undefined)}
        extra={(c) => c.status === "draft" && (
          <Button type="primary" disabled={c.lint_status === "blocked"} onClick={() => setStatus([c.id], "reviewed").then(() => setDetail(undefined))}>审核通过</Button>
        )} />
    </>
  );
}
