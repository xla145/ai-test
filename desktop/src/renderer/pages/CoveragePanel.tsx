import { Alert, Button, Card, Descriptions, Empty, Input, Modal, Select, Space, Table, Tag, Typography } from "antd";
import { useState } from "react";
import { api, type Project } from "../api";
import { CaseLink, CaseTitles } from "../components/CaseLink";
import { useAction, useLoad } from "../hooks";

const stages: Record<string, string> = { draft: "草稿", needs_clarification: "待澄清", ready: "已审核", generated: "已生成", validated: "已验证", confirmed: "已确认", deprecated: "已废弃" };
export function CoveragePanel({ project }: { project: Project }) {
  const [env, setEnv] = useState<string>();
  const [blocked, setBlocked] = useState(false);
  const [stage, setStage] = useState<string>();
  const [reviewing, setReviewing] = useState<any>();
  const [linked, setLinked] = useState<string[]>([]);
  const [owner, setOwner] = useState("");
  const [comment, setComment] = useState("");
  const [mappingLinks, setMappingLinks] = useState<any[]>([]);
  const action = useAction();
  const data = useLoad(() => api().coverage(project.id, env), [project.id, env]);
  const report = data.data;
  const cases = (report?.cases ?? []).filter((c: any) => (!blocked || c.blockers.length) && (!stage || c.lifecycle === stage));
  return <Space direction="vertical" style={{ width: "100%" }} size="middle">
    <Alert showIcon type="info" message="声明的关联需要结合断言内容与执行证据审查"
      description="步骤编号有映射不等于业务语义已验证。缺少映射、过期版本、未执行和待审核的修改均单独列出。" />
    <Space wrap>
      <Select aria-label="覆盖范围环境" allowClear placeholder="全部环境" style={{ minWidth: 160 }} value={env} onChange={setEnv}
        options={Object.keys(project.environments).map(value => ({ value, label: value }))} />
      <Button onClick={() => setBlocked(!blocked)} type={blocked ? "primary" : "default"}>只看缺口</Button>
      <Select allowClear value={stage} onChange={setStage} placeholder="全部阶段" style={{ width: 150 }} options={Object.entries(stages).map(([value, label]) => ({ value, label }))} />
      <Button loading={data.loading} onClick={() => data.reload()}>刷新覆盖</Button>
      {report && <Typography.Text type="secondary">需求 {report.summary.requirements} · 未关联需求 {report.summary.uncovered_requirements} · 声明映射 {report.summary.mapped}/{report.summary.total}</Typography.Text>}
    </Space>
    <Card size="small" title="需求 → 用例">
      <CaseTitles projectId={project.id} ids={(report?.requirements ?? []).flatMap((r: any) => r.case_ids)}>
      <Table size="small" rowKey="id" loading={data.loading} dataSource={report?.requirements ?? []} pagination={{ pageSize: 10 }}
        locale={{ emptyText: <Empty description="尚未导入需求文档；用例仍可在下方检查覆盖" /> }} columns={[
          { title: "需求原文", render: (_: unknown, r: any) => <><Typography.Text strong>{r.section || r.id}</Typography.Text><div style={{ whiteSpace: "pre-wrap" }}>{r.content}</div><Typography.Text type="secondary">{r.source_file}</Typography.Text></> },
          { title: "关联用例", render: (_: unknown, r: any) => r.case_ids.length ? <Space wrap>{r.case_ids.map((id: string) => <CaseLink key={id} id={id} />)}</Space> : <Tag color="orange">未关联</Tag> },
        ]} />
      </CaseTitles>
    </Card>
    <Table size="small" rowKey="case_id" loading={data.loading} dataSource={cases} pagination={{ pageSize: 15 }} scroll={{ x: 800 }}
      columns={[
        { title: "用例", render: (_: unknown, r: any) => <><CaseLink id={r.case_id} /><div>{r.title}</div></> },
        { title: "阶段", dataIndex: "lifecycle", render: (value: string) => <Tag>{stages[value] ?? value}</Tag> },
        { title: "脚本", render: (_: unknown, r: any) => r.script?.path ?? "未生成" },
        { title: "责任与关联", render: (_: unknown, r: any) => <Button size="small" onClick={() => { setReviewing(r); setLinked(r.requirement_ids); setOwner(r.owner); setComment(""); setMappingLinks(r.coverage_links ?? []); }}>审查关联</Button> },
        { title: "覆盖缺口", render: (_: unknown, r: any) => r.blockers.length ? <Space wrap>{r.blockers.map((b: string) => <Tag color="orange" key={b}>{b}</Tag>)}</Space> : <Tag color="green">版本与映射检查通过</Tag> },
      ]} expandable={{ expandedRowRender: (r: any) => <Space direction="vertical" style={{ width: "100%" }}>
        <Descriptions size="small" items={[
          { key: "run", label: "最近执行", children: r.latest_run ? `${r.latest_run.run_id} · ${r.latest_run.env} · ${r.latest_run.status}` : "尚未执行" },
          { key: "owner", label: "责任人", children: r.owner || "未指定" },
        ]} />
        {r.mappings.map((m: any) => <div key={`${m.kind}-${m.index}`} style={{ overflowWrap: "anywhere" }}>
          <Tag color={m.mapped ? "blue" : "orange"}>{m.label} {m.index}</Tag>{m.text}
          <div><Typography.Text type="secondary">{m.assertions.length ? m.assertions.map((a: any) => `${a.id ?? "步骤"} · ${a.action}${a.role ? ` · ${a.role}` : ""}`).join("；") : "未关联脚本动作或断言"}</Typography.Text></div>
        </div>)}
      </Space> }} />
    <Modal open={!!reviewing} title="需求关联与审核意见" onCancel={() => !action.busy && setReviewing(undefined)} confirmLoading={action.busy} onOk={() => action.run(async () => {
      await api().updateCase(reviewing.case_id, { requirement_ids: linked, owner, review_comment: comment, ...(reviewing.mapping_targets?.length ? { coverage_links: mappingLinks } : {}) }, "human");
      await data.reload(); setReviewing(undefined);
    }, "已保存关联与审计记录")}>
      <Space direction="vertical" style={{ width: "100%" }}>
        <Typography.Text>{reviewing?.title}</Typography.Text>
        <Select mode="multiple" aria-label="关联需求" placeholder="关联原始需求" style={{ width: "100%" }} value={linked} onChange={setLinked} options={(report?.requirements ?? []).map((r: any) => ({ value: r.id, label: `${r.section || r.id} · ${r.content.slice(0, 60)}` }))} />
        <Input aria-label="责任人" placeholder="责任人" value={owner} onChange={e => setOwner(e.target.value)} />
        <Input.TextArea aria-label="审核意见" placeholder="审核意见（随本次变更保留）" value={comment} onChange={e => setComment(e.target.value)} />
        {reviewing?.mapping_targets?.length ? <>
          <Alert type="info" message="将原始条目关联到实际请求或断言。修改请求或原文后，旧映射自动失效。" />
          {reviewing.mappings.map((m: any) => <div key={`${m.kind}-${m.index}`} style={{ width: "100%" }}>
            <Typography.Text>{m.label} {m.index} · {m.text}</Typography.Text>
            <Select mode="multiple" style={{ width: "100%" }} aria-label={`${m.label} ${m.index} 的断言映射`}
              value={mappingLinks.filter(link => link.kind === m.kind && link.index === m.index && link.source_revision === reviewing.mapping_source_revision && reviewing.mapping_targets.some((target: any) => target.id === link.target && target.revision === link.target_revision)).map(link => link.target)}
              options={reviewing.mapping_targets.filter((target: any) => m.kind === "steps" ? target.action === "request" : target.action === "expectApi").map((target: any) => ({ value: target.id, label: target.label }))}
              onChange={(ids: string[]) => setMappingLinks(previous => [...previous.filter(link => link.kind !== m.kind || link.index !== m.index), ...ids.map(id => ({ kind: m.kind, index: m.index, target: id, target_revision: reviewing.mapping_targets.find((target: any) => target.id === id).revision, source_revision: reviewing.mapping_source_revision }))])} />
          </div>)}
        </> : null}
      </Space>
    </Modal>
  </Space>;
}
