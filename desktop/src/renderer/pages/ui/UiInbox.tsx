import { CheckOutlined, CloseOutlined } from "@ant-design/icons";
import { Button, Empty, Image, List, Space, Table, Tag, Typography } from "antd";
import { api, type Project } from "../../api";
import { CaseLink, CaseTitles } from "../../components/CaseLink";
import { DiffView } from "../../components/DiffView";
import { notifyProjectChanged, useKeyedAction, type usePaged } from "../../hooks";

export interface Proposal { id: string; case_id: string; script_path: string; diff: string; reason: string; status: string }
export interface Review { id: string; case_id: string; kind: string; description: string; ai_verdict: string; evidence_paths: string[]; status: string }

type Paged<T> = ReturnType<typeof usePaged<T>>;

/** 待处理：AI 提出的脚本修正建议 + 需要人工复核的视觉判定，集中在一处处理 */
export function UiInbox({ project, proposals, reviews }: { project: Project; proposals: Paged<Proposal>; reviews: Paged<Review> }) {
  const empty = !proposals.loading && !reviews.loading && !proposals.total && !reviews.total;
  if (empty) {
    return (
      <div className="uix-panel uix-inbox-empty">
        <Empty description={<>
          <div>没有待处理事项</div>
          <Typography.Text type="secondary">AI 提出的脚本修正和需要人工复核的判定会出现在这里</Typography.Text>
        </>} />
      </div>
    );
  }
  return (
    <div className="uix-inbox">
      <section className="uix-panel">
        <div className="uix-panel-head">
          <span className="uix-panel-title">脚本修正建议</span>
          <span className="uix-count">{proposals.total}</span>
          <Typography.Text type="secondary" className="uix-panel-hint">合并后脚本回到待校验，需要重新试跑</Typography.Text>
        </div>
        <div className="uix-panel-body"><Proposals project={project} paged={proposals} /></div>
      </section>
      <section className="uix-panel">
        <div className="uix-panel-head">
          <span className="uix-panel-title">人工复核</span>
          <span className="uix-count">{reviews.total}</span>
          <Typography.Text type="secondary" className="uix-panel-hint">视觉模型给出的判定，由人确认是否成立</Typography.Text>
        </div>
        <div className="uix-panel-body"><Reviews project={project} paged={reviews} /></div>
      </section>
    </div>
  );
}

function Proposals({ project, paged }: { project: Project; paged: Paged<Proposal> }) {
  const { items: data, loading, reload, pagination } = paged;
  const { busy, activeKey, run } = useKeyedAction();
  if (!loading && !data.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有待处理的修正建议" />;
  const resolve = (p: Proposal, accept: boolean) => run(`${accept ? "merge" : "reject"}:${p.id}`, async () => {
    await api().resolveProposal(project.id, p.id, accept);
    await reload();
    notifyProjectChanged(project.id);
  }, accept ? "已合并并提交到 workspace 的 git" : "已拒绝");
  return (
    <CaseTitles projectId={project.id} ids={data.map((p) => p.case_id)}>
      <List
        loading={loading}
        dataSource={data}
        split={false}
        pagination={{ ...pagination, size: "small", pageSizeOptions: [5, 10, 20], align: "end", hideOnSinglePage: true }}
        renderItem={(p) => (
          <div className="uix-proposal">
            <div className="uix-proposal-head">
              <div style={{ minWidth: 0, flex: 1 }}>
                <CaseLink id={p.case_id} />
                <Typography.Text type="secondary" className="mono" ellipsis style={{ display: "block" }}>{p.script_path}</Typography.Text>
              </div>
              <Space>
                <Button icon={<CloseOutlined />} loading={activeKey === `reject:${p.id}`} disabled={busy} onClick={() => resolve(p, false)}>拒绝</Button>
                <Button type="primary" icon={<CheckOutlined />} loading={activeKey === `merge:${p.id}`} disabled={busy} onClick={() => resolve(p, true)}>合并</Button>
              </Space>
            </div>
            {p.reason && <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>{p.reason}</Typography.Paragraph>}
            <DiffView diff={p.diff} />
          </div>
        )}
      />
    </CaseTitles>
  );
}

function Reviews({ project, paged }: { project: Project; paged: Paged<Review> }) {
  const { items: data, loading, reload, pagination } = paged;
  const workspace = project.workspace_path;
  // 证据路径可能是 workspace 内的相对路径
  const fileUrl = (p: string) => `file://${/^([A-Za-z]:)?[\\/]/.test(p) ? p : `${workspace}/${p}`}`;
  const { busy, activeKey, run } = useKeyedAction();
  const resolve = (r: Review, pass: boolean) => run(`${pass ? "pass" : "fail"}:${r.id}`, async () => {
    await api().resolveReview(r.id, pass);
    await reload();
  });
  return (
    <CaseTitles projectId={project.id} ids={data.map((r) => r.case_id)}>
      <Table
        size="small"
        rowKey="id"
        loading={loading}
        dataSource={data}
        scroll={{ x: 720 }}
        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有待复核的 AI 判定" /> }}
        pagination={{ ...pagination, size: "small", hideOnSinglePage: true }}
        columns={[
          { title: "用例", dataIndex: "case_id", width: 200, render: (id: string) => <CaseLink id={id} /> },
          { title: "判定内容", dataIndex: "description" },
          { title: "AI 结论", dataIndex: "ai_verdict", width: 100, render: (v: string) =>
            v ? <Tag color={v === "pass" ? "green" : "red"} bordered={false}>{v === "pass" ? "通过" : "不通过"}</Tag> : <Tag bordered={false}>未判定</Tag> },
          { title: "截图", dataIndex: "evidence_paths", width: 90, render: (paths: string[]) => paths[0] && (
            <Image width={64} src={fileUrl(paths[0])} fallback="data:image/gif;base64,R0lGODlhAQABAAAAACw=" />
          ) },
          { title: "", width: 170, render: (_: unknown, r: Review) => (
            <Space>
              <Button size="small" type="primary" ghost loading={activeKey === `pass:${r.id}`} disabled={busy} onClick={() => resolve(r, true)}>通过</Button>
              <Button size="small" danger loading={activeKey === `fail:${r.id}`} disabled={busy} onClick={() => resolve(r, false)}>不通过</Button>
            </Space>
          ) },
        ]}
      />
    </CaseTitles>
  );
}
