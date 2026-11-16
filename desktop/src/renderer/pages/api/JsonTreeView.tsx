import { CopyOutlined, PlusCircleOutlined, CaretRightOutlined } from "@ant-design/icons";
import { Button, Input, Tag, Tooltip, Typography } from "antd";
import { useCallback, useMemo, useState } from "react";

interface JsonTreeViewProps {
  data: unknown;
  onCopyPath?: (path: string) => void;
  onAddAssertion?: (path: string, value: unknown) => void;
}

/** 可折叠的 JSON 树形查看器，支持字段搜索、路径复制和一键创建断言。 */
export function JsonTreeView({ data, onCopyPath, onAddAssertion }: JsonTreeViewProps) {
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();

  return (
    <div className="api-json-tree">
      <Input
        size="small"
        placeholder="搜索字段名或值"
        allowClear
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="api-json-tree-search"
      />
      <div className="api-json-tree-content">
        <TreeNode
          keyPath=""
          name={null}
          value={data}
          depth={0}
          defaultOpen
          search={query}
          onCopyPath={onCopyPath}
          onAddAssertion={onAddAssertion}
        />
      </div>
    </div>
  );
}

type NodeValue = unknown;

function typeLabel(value: NodeValue): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `Array[${value.length}]`;
  if (typeof value === "object") return `Object{${Object.keys(value as object).length}}`;
  return typeof value;
}

function typeColor(value: NodeValue): string {
  if (value === null) return "default";
  if (typeof value === "string") return "green";
  if (typeof value === "number") return "blue";
  if (typeof value === "boolean") return "orange";
  if (Array.isArray(value)) return "purple";
  return "cyan";
}

function matchesSearch(name: string | null, value: NodeValue, search: string): boolean {
  if (!search) return true;
  if (name && name.toLowerCase().includes(search)) return true;
  if (value !== null && typeof value !== "object") {
    return String(value).toLowerCase().includes(search);
  }
  return false;
}

function subtreeMatches(name: string | null, value: NodeValue, search: string): boolean {
  if (!search) return true;
  if (matchesSearch(name, value, search)) return true;
  if (value && typeof value === "object") {
    const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value as object);
    return entries.some(([k, v]) => subtreeMatches(k, v, search));
  }
  return false;
}

function formatValue(value: NodeValue): string {
  if (value === null) return "null";
  if (typeof value === "string") return value.length > 120 ? `"${value.slice(0, 120)}…"` : `"${value}"`;
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") return String(value);
  return "";
}

interface TreeNodeProps {
  keyPath: string;
  name: string | null;
  value: NodeValue;
  depth: number;
  defaultOpen?: boolean;
  search: string;
  onCopyPath?: (path: string) => void;
  onAddAssertion?: (path: string, value: unknown) => void;
}

function TreeNode({ keyPath, name, value, depth, defaultOpen = false, search, onCopyPath, onAddAssertion }: TreeNodeProps) {
  const isExpandable = value !== null && typeof value === "object";
  const [open, setOpen] = useState(defaultOpen || depth < 1);
  const entries = useMemo<[string, unknown][]>(() => {
    if (!isExpandable) return [];
    return Array.isArray(value) ? value.map((v, i) => [String(i), v]) : Object.entries(value as object);
  }, [value, isExpandable]);
  const visibleEntries = useMemo(() => {
    if (!search) return entries;
    return entries.filter(([k, v]) => subtreeMatches(k, v, search));
  }, [entries, search]);

  // Force open when searching and there are visible children
  const effectiveOpen = isExpandable && (open || (!!search && visibleEntries.length > 0));
  const isLeaf = !isExpandable;
  const highlight = search && matchesSearch(name, value, search);
  const path = keyPath;

  const handleToggle = useCallback(() => { if (isExpandable) setOpen((v) => !v); }, [isExpandable]);

  return (
    <div className="api-json-tree-node" data-depth={depth}>
      <div
        className={`api-json-tree-row${highlight ? " api-json-tree-highlight" : ""}${isLeaf ? " api-json-tree-leaf" : ""}`}
        style={{ paddingLeft: depth * 20 }}
      >
        {/* Expand toggle */}
        <span className={`api-json-tree-caret${effectiveOpen ? " api-json-tree-caret-open" : ""}${!isExpandable ? " api-json-tree-caret-hidden" : ""}`} onClick={handleToggle}>
          <CaretRightOutlined />
        </span>

        {/* Key name */}
        {name !== null && (
          <span className="api-json-tree-key" onClick={handleToggle}>{name}</span>
        )}

        {/* Value or type summary */}
        {isExpandable ? (
          <Typography.Text type="secondary" className="api-json-tree-type" onClick={handleToggle}>
            {typeLabel(value)}
          </Typography.Text>
        ) : (
          <span className={`api-json-tree-value api-json-tree-value-${typeof value === "string" ? "string" : value === null ? "null" : typeof value}`}>
            {formatValue(value)}
          </span>
        )}

        {/* Inline type badge for leaves */}
        {isLeaf && <Tag bordered={false} color={typeColor(value)} className="api-json-tree-badge">{typeof value}</Tag>}

        {/* Action buttons (visible on hover) */}
        {path && (
          <span className="api-json-tree-actions">
            {onCopyPath && (
              <Tooltip title={`复制路径: ${path}`} mouseEnterDelay={0.4}>
                <Button type="text" size="small" className="api-json-tree-action" icon={<CopyOutlined />} onClick={() => onCopyPath(path)} />
              </Tooltip>
            )}
            {onAddAssertion && isLeaf && (
              <Tooltip title="添加为断言" mouseEnterDelay={0.4}>
                <Button type="text" size="small" className="api-json-tree-action" icon={<PlusCircleOutlined />} onClick={() => onAddAssertion(path, value)} />
              </Tooltip>
            )}
          </span>
        )}
      </div>

      {/* Children */}
      {effectiveOpen && visibleEntries.map(([childKey, childValue]) => {
        const childPath = path ? (Array.isArray(value) ? `${path}.${childKey}` : `${path}.${childKey}`) : childKey;
        return (
          <TreeNode
            key={childKey}
            keyPath={childPath}
            name={childKey}
            value={childValue}
            depth={depth + 1}
            search={search}
            onCopyPath={onCopyPath}
            onAddAssertion={onAddAssertion}
          />
        );
      })}
    </div>
  );
}
