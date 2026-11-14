import { CheckOutlined, ClusterOutlined, FolderOpenOutlined, PlusOutlined, DownOutlined } from "@ant-design/icons";
import { Dropdown, Tooltip, theme, type MenuProps } from "antd";
import { isGroup, type Project } from "../api";

/**
 * 项目切换器：项目列表收进下拉菜单，可用于顶部工具栏或紧凑入口。
 */
export function ProjectSwitcher({ projects, current, compact, onSelect, onCreate }: {
  projects: Project[];
  current?: Project;
  compact: boolean;
  onSelect: (id: string) => void;
  onCreate: (preset: { parent?: string; kind?: "project" | "group" }) => void;
}) {
  const { token } = theme.useToken();
  const groups = projects.filter(isGroup);
  const standalone = projects.filter((p) => !isGroup(p) && !p.parent_id);
  const parent = current?.parent_id ? projects.find((p) => p.id === current.parent_id) : undefined;
  const check = (id: string) => (id === current?.id ? <CheckOutlined style={{ color: token.colorPrimary }} /> : null);
  const item = (p: Project, child = false) => ({
    key: p.id,
    className: child ? "project-choice project-choice-child" : "project-choice",
    icon: child ? <span className="project-branch" aria-hidden="true" /> : isGroup(p) ? <ClusterOutlined /> : <FolderOpenOutlined />,
    label: <span className="switcher-item"><span className="switcher-item-name" title={p.name}>{p.name}</span>{check(p.id)}</span>,
  });
  const currentGroup = current && isGroup(current) ? current : parent;
  const items: MenuProps["items"] = [
    ...groups.flatMap((g, index) => [
      ...(index ? [{ type: "divider" as const }] : []),
      item(g),
      ...projects.filter((p) => p.parent_id === g.id).map((p) => item(p, true)),
    ]),
    ...(groups.length && standalone.length ? [{ type: "divider" as const }] : []),
    ...standalone.map((p) => item(p)),
    ...(projects.length ? [{ type: "divider" as const }] : []),
    { key: "create", icon: <PlusOutlined />, label: "新建…", children: [
      { key: "create:project", label: "独立项目" },
      ...(currentGroup ? [{ key: `new:${currentGroup.id}`, label: `子项目 · ${currentGroup.name}` }] : []),
      { key: "create:group", label: "大项目" },
    ] },
  ];

  const onClick: MenuProps["onClick"] = ({ key }) => {
    if (key.startsWith("new:")) return onCreate({ parent: key.slice(4) });
    if (key === "create:project") return onCreate({});
    if (key === "create:group") return onCreate({ kind: "group" });
    onSelect(key);
  };

  const name = current?.name ?? "选择项目";
  return (
    <Dropdown trigger={["click"]} menu={{ items, onClick, selectable: true, selectedKeys: current ? [current.id] : [], triggerSubMenuAction: "click" }} placement="bottomLeft"
      overlayClassName="switcher-menu">
      <Tooltip title={compact ? `${parent ? `${parent.name} / ` : ""}${name}（切换项目）` : undefined} placement="right">
        <button type="button" className={`switcher ${compact ? "compact" : ""}`} aria-label="切换项目">
          <span className="switcher-icon" style={{ color: token.colorTextSecondary }}>
            {!current ? <PlusOutlined /> : isGroup(current) ? <ClusterOutlined /> : <FolderOpenOutlined />}
          </span>
          {!compact && (
            <>
              <span className="switcher-name">
                {parent && <span style={{ color: token.colorTextTertiary, fontWeight: 400 }}>{parent.name} / </span>}
                {name}
              </span>
              <DownOutlined style={{ color: token.colorTextQuaternary, fontSize: 10 }} />
            </>
          )}
        </button>
      </Tooltip>
    </Dropdown>
  );
}
