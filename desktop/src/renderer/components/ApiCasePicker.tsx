import { Alert, Button, Card, Input, Modal, Select, Space, Table, Tag, Typography } from "antd";
import { useEffect, useMemo, useState } from "react";
import type { ApiTestSet } from "../../shared/ipc";
import { api, type ApiStep, type TestCase } from "../api";
import { useAction } from "../hooks";

const apiSteps = (c: TestCase): ApiStep[] => c.api_flow?.length ? c.api_flow : c.api ? [c.api] : [];
const apiEndpoints = (c: TestCase) => apiSteps(c).map((s) => `${s.method.toUpperCase()} ${s.path}`);
const eligibleApiCases = (cases: TestCase[]) => cases.filter((c) =>
  c.execution_mode === "api" && c.status === "reviewed" && c.lint_status !== "blocked" && apiSteps(c).length > 0);

interface CaseRow {
  key: string;
  label: string;
  case?: TestCase;
  children?: CaseRow[];
}

function groupApiCases(cases: TestCase[]): CaseRow[] {
  const groups = new Map<string, CaseRow>();
  for (const c of cases) {
    const label = `${c.api_flow?.length ? "流程：" : ""}${apiEndpoints(c).join(" → ")}`;
    const key = `endpoint:${label}`;
    if (!groups.has(key)) groups.set(key, { key, label, children: [] });
    groups.get(key)!.children!.push({ key: c.id, label: c.title, case: c });
  }
  return [...groups.values()];
}

export function ApiCasePicker({ projectId, selected, onSelect, onAvailable, disabled, onBusyChange }: {
  projectId: string;
  selected: string[];
  onSelect: (ids: string[]) => void;
  onAvailable: (cases: TestCase[]) => void;
  disabled?: boolean;
  onBusyChange: (busy: boolean) => void;
}) {
  const [cases, setCases] = useState<TestCase[]>([]);
  const [scripts, setScripts] = useState<Record<string, string>>({});
  const [sets, setSets] = useState<ApiTestSet[]>([]);
  const [query, setQuery] = useState("");
  const [method, setMethod] = useState<string>();
  const [module, setModule] = useState<string>();
  const [saveOpen, setSaveOpen] = useState(false);
  const [name, setName] = useState("");
  const [loadedSet, setLoadedSet] = useState<string>();
  const { busy, run } = useAction();
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);
  const load = async () => {
    const [rows, map, saved] = await Promise.all([
      api().listCases(projectId, { execution_mode: "api", status: "reviewed" }),
      api().scriptMap("pytest"), api().listApiTestSets(projectId),
    ]);
    const eligible = eligibleApiCases(rows as TestCase[]);
    setCases(eligible);
    onAvailable(eligible);
    setScripts(map);
    setSets(saved);
  };
  useEffect(() => { void run(load); }, [projectId]);
  const filtered = useMemo(() => cases.filter((c) => {
    const text = query.trim().toLowerCase();
    return (!module || c.module_path.join(" / ") === module) &&
      (!method || apiSteps(c).some((s) => s.method.toUpperCase() === method)) &&
      (!text || [c.id, c.title, c.module_path.join(" / "), ...apiEndpoints(c)].join(" ").toLowerCase().includes(text));
  }), [cases, query, method, module]);
  const available = new Set(cases.map((c) => c.id));
  const invalid = selected.filter((id) => !available.has(id));
  const selectedCases = cases.filter((c) => selected.includes(c.id));
  const endpointCount = new Set(selectedCases.flatMap(apiEndpoints)).size;
  const changeSelection = (ids: string[]) => { onSelect(ids); setLoadedSet(undefined); };

  return (
    <Card title="选择本次测试范围" style={{ marginBottom: 16 }} extra={<Space>
      <Button loading={busy} disabled={disabled} onClick={() => run(load)}>刷新</Button>
      <Button loading={busy} disabled={disabled} onClick={() => run(async () => {
        await api().writeReviewedApiSuite(projectId);
        await load();
      }, "已生成已审核接口用例的脚本")}>生成已审核脚本</Button>
    </Space>}>
      <Typography.Paragraph type="secondary">
        仅展示已审核且无阻断问题的接口用例。勾选接口可选择其下全部用例，展开后可单独选择；流程用例始终按全部步骤执行。
      </Typography.Paragraph>
      <Space wrap style={{ marginBottom: 12 }}>
        <Input allowClear aria-label="搜索接口或用例" placeholder="搜索接口路径、用例或模块" value={query}
          onChange={(e) => setQuery(e.target.value)} style={{ width: 260 }} />
        <Select allowClear aria-label="请求方法" placeholder="请求方法" value={method} onChange={setMethod} style={{ width: 120 }}
          options={[...new Set(cases.flatMap((c) => apiSteps(c).map((s) => s.method.toUpperCase())))].sort().map((m) => ({ value: m }))} />
        <Select allowClear aria-label="模块" placeholder="模块" value={module} onChange={setModule} style={{ width: 180 }}
          options={[...new Set(cases.map((c) => c.module_path.join(" / ")))].filter(Boolean).map((m) => ({ value: m }))} />
        <Select allowClear placeholder="加载测试集" value={loadedSet} style={{ width: 180 }}
          options={sets.map((s) => ({ value: s.name, label: `${s.name}（${s.case_ids.length} 条）` }))}
          onChange={(value) => {
            setLoadedSet(value);
            if (value) onSelect(sets.find((s) => s.name === value)!.case_ids);
          }} />
      </Space>
      <Space wrap style={{ display: "flex", marginBottom: 12 }}>
        <Typography.Text>已选 {endpointCount} 个接口、{selected.length} 条用例</Typography.Text>
        <Button size="small" disabled={busy || disabled || !filtered.length} onClick={() => changeSelection(
          [...new Set([...selected, ...filtered.map((c) => c.id)])])}>选择筛选结果（{filtered.length} 条）</Button>
        <Button size="small" disabled={!selected.length || disabled || busy} onClick={() => changeSelection([])}>清空选择</Button>
        <Button size="small" disabled={!selected.length || !!invalid.length || busy || disabled} onClick={() => { setName(""); setSaveOpen(true); }}>保存为测试集</Button>
        <Typography.Text type="secondary">筛选不会清除已选项</Typography.Text>
      </Space>
      {invalid.length > 0 && <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={`已选项中有 ${invalid.length} 条用例已废弃、未审核或不可执行，请清空后重新选择。`} />}
      <Table<CaseRow> size="small" loading={busy || disabled} dataSource={groupApiCases(filtered)} rowKey="key" scroll={{ x: 650 }}
        pagination={{ defaultPageSize: 10, showSizeChanger: true, showTotal: (n) => `共 ${n} 组接口 / 流程` }}
        rowSelection={{ checkStrictly: false, selectedRowKeys: selected, preserveSelectedRowKeys: true,
          onChange: (keys) => changeSelection(keys.map(String).filter((k) => !k.startsWith("endpoint:"))) }}
        columns={[
          { title: "接口 / 用例", dataIndex: "label", render: (label: string, row) => row.case
            ? <><Typography.Text>{label}</Typography.Text><div><Typography.Text type="secondary">{row.case.id}</Typography.Text></div></>
            : <Typography.Text className="mono" style={{ wordBreak: "break-all" }}>{label}</Typography.Text> },
          { title: "用例数 / 等级", width: 120, render: (_, row) => row.case ? row.case.priority : `${row.children?.length} 条` },
          { title: "脚本", width: 110, render: (_, row) => row.case
            ? <Tag color={scripts[row.case.id] ? "green" : "orange"}>{scripts[row.case.id] ? "已生成" : "待生成"}</Tag> : null },
        ]} />
      <Modal title="保存测试集" open={saveOpen} confirmLoading={busy} okButtonProps={{ disabled: !name.trim() }}
        onCancel={() => setSaveOpen(false)} onOk={() => run(async () => {
          const saved = await api().saveApiTestSet(projectId, name.trim(), selected);
          setSets((old) => [...old.filter((s) => s.name !== saved.name), saved]);
          setLoadedSet(saved.name);
          setSaveOpen(false);
        }, "测试集已保存")}>
        <Input aria-label="测试集名称" placeholder="例如：订单冒烟" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
        <Typography.Paragraph type="secondary" style={{ marginTop: 12 }}>保存当前 {selected.length} 条用例的选择范围；同名测试集将被更新。</Typography.Paragraph>
      </Modal>
    </Card>
  );
}
