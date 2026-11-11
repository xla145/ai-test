import { CheckOutlined, ClusterOutlined, FolderOpenOutlined, PlusOutlined, DownOutlined } from "@ant-design/icons";
import { Dropdown, Tooltip, Typography, theme, type MenuProps } from "antd";
import { isGroup, type Project } from "../api";

/**
 * 侧栏顶部的项目切换器：项目列表收进下拉菜单，侧栏只保留当前项目的功能导航。
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
  const item = (p: Project, label = p.name, indent = false) => ({
    key: p.id,
    icon: isGroup(p) ? <ClusterOutlined /> : <FolderOpenOutlined />,
    label: <span className="switcher-item" style={indent ? { paddingInlineStart: 16 } : undefined}><span>{label}</span>{check(p.id)}</span>,
  });

  const items: MenuProps["items"] = [
    ...groups.map((g) => ({
      key: `group:${g.id}`,
      type: "group" as const,
      label: g.name,
      children: [
        item(g, "概览与共享配置"),
        ...projects.filter((p) => p.parent_id === g.id).map((p) => item(p, p.name, true)),
        { key: `new:${g.id}`, icon: <PlusOutlined />, label: <Typography.Text type="secondary" style={{ paddingInlineStart: 16 }}>新建子项目</Typography.Text> },
      ],
    })),
    ...(standalone.length ? [{ key: "standalone", type: "group" as const, label: "独立项目", children: standalone.map((p) => item(p)) }] : []),
    { type: "divider" as const },
    { key: "create:project", icon: <PlusOutlined />, label: "新建项目" },
    { key: "create:group", icon: <ClusterOutlined />, label: "新建大项目" },
  ];

  const onClick: MenuProps["onClick"] = ({ key }) => {
    if (key.startsWith("new:")) return onCreate({ parent: key.slice(4) });
    if (key === "create:project") return onCreate({});
    if (key === "create:group") return onCreate({ kind: "group" });
    onSelect(key);
  };

  const name = current?.name ?? "选择项目";
  return (
    <Dropdown trigger={["click"]} menu={{ items, onClick, selectable: false }} placement="bottomLeft"
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
