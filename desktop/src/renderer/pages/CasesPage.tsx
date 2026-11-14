import { CheckOutlined, ClearOutlined, FileExcelOutlined, SearchOutlined, StopOutlined } from "@ant-design/icons";
import { App, Button, Flex, Input, Popconfirm, Select, Space, Table, Tag, Typography } from "antd";
import { useRef, useState } from "react";
import { api, type Project, type TestCase } from "../api";
import { CaseDrawer, PRIORITY_COLOR } from "../components/CaseLink";
import { LabelTag, LINT, MODE, STATUS } from "../components/labels";
import { PageHeader } from "../components/PageHeader";
import { useAction, useDebounced, usePaged, notifyProjectChanged } from "../hooks";


export function CasesPage({ project }: { project: Project }) {
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<{ mode?: string; priority?: string; status?: string; lint?: string }>({});
  const [selected, setSelected] = useState<string[]>([]);
  const [detail, setDetail] = useState<TestCase>();
  const { run } = useAction();
  const [activeAction, setActiveAction] = useState<string>();
  const actionRef = useRef<string>();
  const busy = activeAction !== undefined;
  const runAction = async (action: string, fn: () => Promise<void>, success?: string) => {
    if (actionRef.current) return;
    actionRef.current = action;
    setActiveAction(action);
    try {
      await run(fn, success);
    } finally {
      actionRef.current = undefined;
      setActiveAction(undefined);
    }
  };
  const { modal } = App.useApp();
  const q = useDebounced(query.trim());
  // 搜索与筛选在引擎端执行，按页读取
  const { items: rows, loading, reload, pagination } = usePaged<TestCase>(
    (page) => api().pageCases(project.id, {
      ...page, query: q || undefined,
      filters: { execution_mode: filters.mode, priority: filters.priority, status: filters.status, lint_status: filters.lint },
    }) as Promise<{ items: TestCase[]; total: number }>,
    [project.id, q, filters],
  );

  const setStatus = (ids: string[], status: string, source = "selection") => runAction(`${status}:${source}`, async () => {
    for (const id of ids) await api().updateCase(id, { status }, "human");
    notifyProjectChanged(project.id);
    setSelected([]);
    await reload();
  }, `已更新 ${ids.length} 条用例`);

  // 一键清空：危险操作，弹窗二次确认，确认按钮为红色
  const clearAll = () => modal.confirm({
    title: `清空「${project.name}」的用例库？`,
    content: (
      <>
        <Typography.Paragraph>
          将删除全部 <Typography.Text strong>{pagination.total ?? 0}</Typography.Text> 条用例，
          以及它们的规范检查问题、脚本登记、UI 脚本修改建议与人工复核，<Typography.Text type="danger">不可恢复</Typography.Text>。
        </Typography.Paragraph>
        <Typography.Text type="secondary">执行记录（测试报告）与 workspace 中已生成的脚本文件会保留。</Typography.Text>
      </>
    ),
    okText: "确认清空",
    okButtonProps: { danger: true },
    cancelText: "取消",
    autoFocusButton: "cancel",
    onOk: () => runAction("clear", async () => {
      await api().clearCases(project.id);
      setSelected([]);
      await reload();
      notifyProjectChanged(project.id);
    }, "用例库已清空"),
  });

  const options = (map: Record<string, { text: string }>) => Object.entries(map).map(([value, v]) => ({ value, label: v.text }));

  return (
    <>
      <PageHeader title="用例库"
        workflow={[
          { title: "筛选用例", description: "按模块、执行方式、等级和审核状态筛选" },
          { title: "检查规范", description: "核对用例内容，先处理阻断级问题" },
          { title: "人工审核", description: "通过审核的用例才能进入回归" },
          { title: "执行回归", description: "到对应测试页面生成并执行脚本" },
        ]} description="用例需人工审核后才进入回归；有阻断问题的用例不会生成脚本。"
        extra={<>
          <Button icon={<FileExcelOutlined />} loading={activeAction === "export"} disabled={busy && activeAction !== "export"}
          onClick={() => runAction("export", async () => {
            const out = await api().exportCasesExcel(project.id, project.name);
            if (out) await api().showInFolder(out.path).catch(() => undefined);
          })}>导出 Excel</Button>
          <Button type="text" danger icon={<ClearOutlined />} loading={activeAction === "clear"} disabled={busy || !pagination.total} onClick={clearAll}>清空用例库</Button>
        </>} />
      <div className="data-surface cases-surface">
        <div className="case-filter-grid">
          <Input className="case-search" aria-label="搜索用例" allowClear prefix={<SearchOutlined />} placeholder="搜索标题、模块或用例 ID"
            value={query} onChange={(e) => setQuery(e.target.value)} />
          <Select aria-label="执行方式" allowClear placeholder="执行方式" options={options(MODE)} value={filters.mode} onChange={(v) => setFilters({ ...filters, mode: v })} />
          <Select aria-label="等级" allowClear placeholder="等级" options={["P0", "P1", "P2", "P3"].map((p) => ({ value: p, label: p }))} value={filters.priority} onChange={(v) => setFilters({ ...filters, priority: v })} />
          <Select aria-label="审核状态" allowClear placeholder="审核状态" options={options(STATUS)} value={filters.status} onChange={(v) => setFilters({ ...filters, status: v })} />
          <Select aria-label="规范检查" allowClear placeholder="规范检查" options={options(LINT)} value={filters.lint} onChange={(v) => setFilters({ ...filters, lint: v })} />
        </div>
        {(query || Object.values(filters).some(Boolean)) && <div className="filter-feedback">
          <Typography.Text type="secondary">找到 {pagination.total ?? 0} 条用例</Typography.Text>
          <Button type="link" size="small" onClick={() => { setQuery(""); setFilters({}); }}>重置筛选</Button>
        </div>}
          {selected.length > 0 && (
            <Space className="selection-toolbar" wrap>
              <Typography.Text type="secondary">已选 {selected.length} 条</Typography.Text>
              <Button type="primary" icon={<CheckOutlined />} loading={activeAction === "reviewed:selection"} disabled={busy && activeAction !== "reviewed:selection"} onClick={() => setStatus(selected, "reviewed")}>审核通过</Button>
              <Popconfirm title="确定废弃选中的用例？" disabled={busy} onConfirm={() => setStatus(selected, "deprecated")}>
                <Button danger icon={<StopOutlined />} loading={activeAction === "deprecated:selection"} disabled={busy && activeAction !== "deprecated:selection"}>废弃</Button>
              </Popconfirm>
            </Space>
          )}
      <Table
        size="small"
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
            <button type="button" className="case-title-link" onClick={() => setDetail(r)}><span>{t?.trim() || "未填写标题"}</span><small>{r.module_path.join(" / ")}</small></button>
          ) },
          { title: "等级", dataIndex: "priority", width: 80,
            render: (p: string) => <Tag color={PRIORITY_COLOR[p]} bordered={false}>{p}</Tag> },
          { title: "执行方式", dataIndex: "execution_mode", width: 110, render: (v: string) => <LabelTag map={MODE} value={v} /> },
          { title: "规范检查", dataIndex: "lint_status", width: 100, render: (v: string) => <LabelTag map={LINT} value={v} /> },
          { title: "状态", dataIndex: "status", width: 80, render: (v: string) => <LabelTag map={STATUS} value={v} /> },
          { title: "", width: 100, render: (_: unknown, r: TestCase) => r.status === "draft" && (
            <Button size="small" type="link" loading={activeAction === `reviewed:${r.id}`} disabled={busy || r.lint_status === "blocked"} onClick={() => setStatus([r.id], "reviewed", r.id)}>审核通过</Button>
          ) },
        ]}
      />
      </div>
      <CaseDrawer caseId={detail?.id} data={detail} onClose={() => setDetail(undefined)}
        extra={(c) => c.status === "draft" && (
          <Button type="primary" loading={activeAction === `reviewed:drawer:${c.id}`} disabled={busy || c.lint_status === "blocked"} onClick={() => setStatus([c.id], "reviewed", `drawer:${c.id}`).then(() => setDetail(undefined))}>审核通过</Button>
        )} />
    </>
  );
}
