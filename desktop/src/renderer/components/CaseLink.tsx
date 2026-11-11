import { Descriptions, Drawer, Skeleton, Table, Tag, Typography } from "antd";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, type TestCase } from "../api";
import { LabelTag, LINT, MODE, STATUS } from "./labels";

export const PRIORITY_COLOR: Record<string, string> = { P0: "red", P1: "orange", P2: "blue", P3: "default" };

/** 按 ID 批量取用例标题；ids 变化时重新读取 */
export function useCaseTitles(projectId: string, ids: (string | undefined)[]): Record<string, string> {
  const [titles, setTitles] = useState<Record<string, string>>({});
  const key = [...new Set(ids.filter(Boolean))].sort().join(",");
  useEffect(() => {
    if (!key) return;
    let alive = true;
    api().caseTitles(projectId, key.split(",")).then((t) => alive && setTitles(t), () => undefined);
    return () => {
      alive = false;
    };
  }, [projectId, key]);
  return titles;
}

/** 用例标题与详情抽屉：在归因、复核等列表里用标题代替 ID，点击查看详情 */
const TitlesContext = createContext<Record<string, string>>({});

export function CaseTitles({ projectId, ids, children }: { projectId: string; ids: (string | undefined)[]; children: ReactNode }) {
  const titles = useCaseTitles(projectId, ids);
  return <TitlesContext.Provider value={titles}>{children}</TitlesContext.Provider>;
}

export function CaseLink({ id, title }: { id: string; title?: string }) {
  const titles = useContext(TitlesContext);
  const [open, setOpen] = useState(false);
  const name = title ?? titles[id];
  return (
    <>
      <div style={{ minWidth: 0 }}>
        {name ? (
          <Typography.Link onClick={() => setOpen(true)} ellipsis style={{ display: "block" }}>{name}</Typography.Link>
        ) : null}
        <Typography.Text type="secondary" className="mono" style={{ fontSize: 12 }}>{id}</Typography.Text>
      </div>
      {name && <CaseDrawer caseId={open ? id : undefined} onClose={() => setOpen(false)} />}
    </>
  );
}

/** 用例详情抽屉：caseId 有值时打开并读取最新内容 */
export function CaseDrawer({ caseId, onClose, extra, data }: {
  caseId?: string;
  onClose: () => void;
  extra?: (c: TestCase) => ReactNode;
  /** 已有的用例数据（用例库中直接传入，避免再读一次） */
  data?: TestCase;
}) {
  const [loaded, setLoaded] = useState<TestCase>();
  useEffect(() => {
    if (!caseId || data) return;
    setLoaded(undefined);
    let alive = true;
    api().getCase(caseId).then((c) => alive && setLoaded(c as TestCase), () => undefined);
    return () => {
      alive = false;
    };
  }, [caseId, data]);
  const detail = data ?? loaded;
  return (
    <Drawer open={!!caseId} onClose={onClose} width={560} title={detail?.title ?? caseId} extra={detail && extra?.(detail)}>
      {!detail ? <Skeleton active /> : (
        <>
          <Descriptions size="small" column={2} items={[
            { key: "id", label: "用例 ID", children: <span className="mono">{detail.id}</span>, span: 2 },
            { key: "m", label: "模块", children: detail.module_path.join(" / ") || "—", span: 2 },
            { key: "p", label: "等级", children: <Tag color={PRIORITY_COLOR[detail.priority]} bordered={false}>{detail.priority}</Tag> },
            { key: "c", label: "类型", children: detail.category },
            { key: "e", label: "执行方式", children: <LabelTag map={MODE} value={detail.execution_mode} /> },
            { key: "s", label: "审核状态", children: <LabelTag map={STATUS} value={detail.status} /> },
            { key: "l", label: "规范检查", children: <LabelTag map={LINT} value={detail.lint_status} />, span: 2 },
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
  );
}
