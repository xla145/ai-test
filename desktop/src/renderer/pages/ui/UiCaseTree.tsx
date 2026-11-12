import { FileTextOutlined, FolderOpenOutlined, FolderOutlined, RightOutlined } from "@ant-design/icons";
import { Button, Checkbox } from "antd";
import { useMemo, useState, type ReactNode } from "react";
import type { UiGroupCase } from "../../../shared/ipc";
import { buildUiCaseTree, type UiModuleNode } from "../../../shared/uiCaseTree";

type Props = {
  cases: UiGroupCase[];
  selected: Record<string, UiGroupCase>;
  currentId?: string;
  query: string;
  locked: boolean;
  onPick: (cases: UiGroupCase[], checked: boolean) => void;
  onChoose: (c: UiGroupCase) => void;
  renderMeta: (c: UiGroupCase) => ReactNode;
};

export function UiCaseTree(props: Props) {
  const modules = useMemo(() => buildUiCaseTree(props.cases), [props.cases]);
  const [expansion, setExpansion] = useState<{ all?: boolean; nodes: Record<string, boolean> }>({ nodes: {} });
  return <div className="uix-module-tree">
    {modules.length > 0 && <div className="uix-tree-toolbar">
      <span>{modules.length} 个模块 · {props.cases.length} 条用例</span>
      <Button size="small" type="text" onClick={() => setExpansion({ all: !expansion.all, nodes: {} })}>
        {expansion.all ? "全部收起" : "全部展开"}
      </Button>
    </div>}
    {modules.map((node) => <ModuleBranch key={node.key} node={node} props={props} depth={0}
      expansion={expansion} toggle={(key, open) => setExpansion((old) => ({ ...old, nodes: { ...old.nodes, [key]: open } }))} />)}
  </div>;
}

function ModuleBranch({ node, props, depth, expansion, toggle }: {
  node: UiModuleNode; props: Props; depth: number;
  expansion: { all?: boolean; nodes: Record<string, boolean> };
  toggle: (key: string, open: boolean) => void;
}) {
  const [limit, setLimit] = useState(60);
  const hasCurrent = node.descendants.some((c) => c.id === props.currentId);
  const open = (expansion.nodes[node.key] ?? expansion.all ?? (Boolean(props.query) || hasCurrent || depth < 1));
  const checked = node.descendants.every((c) => Boolean(props.selected[c.id]));
  const entries = [...node.modules.map((module) => ({ module })), ...node.cases.map((item) => ({ item }))];
  // 当前用例即使排在加载范围之后也保持可见。
  const currentIndex = entries.findIndex((entry) => "item" in entry && entry.item.id === props.currentId);
  const shownLimit = Math.max(limit, currentIndex + 1);
  return <div className="uix-module">
    <div className="uix-module-head">
      <button type="button" className="uix-module-toggle" aria-expanded={open} aria-label={`${open ? "收起" : "展开"}模块 ${node.name}`}
        onClick={() => toggle(node.key, !open)}>
        <RightOutlined className={`uix-module-caret ${open ? "open" : ""}`} />
        {open ? <FolderOpenOutlined className="uix-folder" /> : <FolderOutlined className="uix-folder" />}
      </button>
      <Checkbox checked={checked} indeterminate={!checked && node.descendants.some((c) => props.selected[c.id])}
        disabled={props.locked} aria-label={`选择模块 ${node.name} 下的用例`} onChange={(e) => props.onPick(node.descendants, e.target.checked)} />
      <button type="button" className="uix-module-name" aria-expanded={open} onClick={() => toggle(node.key, !open)} title={node.name}>{node.name}</button>
      <span className="uix-count">{node.descendants.length}</span>
    </div>
    {open && <div className="uix-module-children">
      {entries.slice(0, shownLimit).map((entry) => "module" in entry
        ? <ModuleBranch key={entry.module.key} node={entry.module} props={props} depth={depth + 1} expansion={expansion} toggle={toggle} />
        : <div key={entry.item.id} className={`uix-case uix-tree-case ${props.currentId === entry.item.id ? "active" : ""} ${props.locked ? "locked" : ""}`}>
          <Checkbox checked={Boolean(props.selected[entry.item.id])} disabled={props.locked} aria-label={`选择 ${entry.item.title}`}
            onChange={(e) => props.onPick([entry.item], e.target.checked)} />
          <button type="button" className="uix-tree-case-button" disabled={props.locked} aria-current={props.currentId === entry.item.id ? "true" : undefined}
            onClick={() => props.onChoose(entry.item)}>
            <div className="uix-case-title"><FileTextOutlined className="uix-file" />{entry.item.title}</div>
            <div className="uix-case-meta">{props.renderMeta(entry.item)}</div>
          </button>
        </div>)}
      {entries.length > shownLimit && <Button type="link" size="small" block onClick={() => setLimit(shownLimit + 60)}>显示更多（还有 {entries.length - shownLimit} 项）</Button>}
    </div>}
  </div>;
}
