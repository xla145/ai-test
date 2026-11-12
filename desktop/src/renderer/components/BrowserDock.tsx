import { ChromeOutlined, CloseOutlined, ReloadOutlined } from "@ant-design/icons";
import { Button, Empty, Space, Tooltip, Typography } from "antd";
import { useEffect, useRef, useState } from "react";
import type { ViewDock } from "../../shared/ipc";
import { api } from "../api";

/** 会盖在停靠区上的浮层：与停靠区相交时暂时隐藏原生视图（WebContentsView 总在 DOM 之上） */
const OVERLAYS = [
  ".ant-modal-wrap", ".ant-drawer-content-wrapper", ".ant-image-preview-wrap",
  ".ant-select-dropdown:not(.ant-select-dropdown-hidden)", ".ant-dropdown:not(.ant-dropdown-hidden)",
  ".ant-picker-dropdown:not(.ant-picker-dropdown-hidden)", ".ant-popover:not(.ant-popover-hidden)",
].join(",");

const intersects = (a: DOMRect, b: DOMRect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

function covered(rect: DOMRect): boolean {
  for (const el of document.querySelectorAll<HTMLElement>(OVERLAYS)) {
    const r = el.getBoundingClientRect();
    if (r.width && r.height && getComputedStyle(el).display !== "none" && intersects(r, rect)) return true;
  }
  return false;
}

/** 可见区域 = 占位框 ∩ 所有可滚动祖先的可视区域（滚出内容区时不盖住页头） */
function visibleRect(el: HTMLElement): DOMRect {
  let { left, top, right, bottom } = el.getBoundingClientRect();
  for (let p = el.parentElement; p; p = p.parentElement) {
    const style = getComputedStyle(p);
    if (!/(auto|scroll|hidden)/.test(style.overflow + style.overflowY + style.overflowX)) continue;
    const r = p.getBoundingClientRect();
    left = Math.max(left, r.left); top = Math.max(top, r.top);
    right = Math.min(right, r.right); bottom = Math.min(bottom, r.bottom);
  }
  return new DOMRect(left, top, Math.max(0, right - left), Math.max(0, bottom - top));
}

/**
 * 内嵌浏览器停靠区：把主进程的被测页面视图嵌进页面布局，而不是浮在右半屏。
 * 视图未打开时显示占位提示。
 */
export function BrowserDock({ url, title = "内嵌浏览器", session }: { url?: string; title?: string; session?: { projectId: string; env: string } }) {
  const box = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [shown, setShown] = useState(false);

  useEffect(() => api().onViewChange?.((v) => { setVisible(v.visible); setShown(v.shown ?? v.visible); }), []);

  useEffect(() => {
    const el = box.current;
    if (!el || !api().dockTestView) return;
    let last = "";
    let frame = 0;
    const report = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        // 所在页签被切走（display:none）时不占用视图，交回右半屏显示，否则视图会被压成 0 尺寸
        if (!el.getClientRects().length) {
          if (last !== "null") { last = "null"; void api().dockTestView!(null); }
          return;
        }
        const r = visibleRect(el);
        const dock: ViewDock = { x: r.left, y: r.top, width: r.width, height: r.height, suspended: covered(r) };
        const key = JSON.stringify(dock);
        if (key === last) return;
        last = key;
        void api().dockTestView!(dock);
      });
    };
    report();
    const resize = new ResizeObserver(report);
    resize.observe(el);
    resize.observe(document.body);
    // 弹窗、下拉的出现与消失靠 DOM 变化感知
    const mutations = new MutationObserver(report);
    mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style"] });
    window.addEventListener("scroll", report, true);
    window.addEventListener("resize", report);
    // 抽屉、弹窗的进出场动画结束后位置才稳定
    document.addEventListener("transitionend", report, true);
    document.addEventListener("animationend", report, true);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
      window.removeEventListener("scroll", report, true);
      window.removeEventListener("resize", report);
      document.removeEventListener("transitionend", report, true);
      document.removeEventListener("animationend", report, true);
      void api().dockTestView!(null);
    };
  }, []);

  return (
    <div className="browser-dock">
      <div className="browser-dock-bar">
        <Space size={6} style={{ minWidth: 0 }}>
          <ChromeOutlined />
          <Typography.Text strong>{title}</Typography.Text>
          {url && <Typography.Text type="secondary" className="mono" ellipsis style={{ maxWidth: 260, fontSize: 12 }}>{url}</Typography.Text>}
        </Space>
        <Space size={4}>
          {url && (
            <Tooltip title={visible ? "重新打开被测页面" : "打开被测页面"}>
              <Button size="small" type="text" icon={visible ? <ReloadOutlined /> : <ChromeOutlined />} aria-label="打开被测页面"
                onClick={() => void api().openTestPage(url, session)} />
            </Tooltip>
          )}
          {visible && (
            <Tooltip title="关闭浏览器视图（登录态保留）">
              <Button size="small" type="text" icon={<CloseOutlined />} aria-label="关闭浏览器视图" onClick={() => void api().hideTestView?.()} />
            </Tooltip>
          )}
        </Space>
      </div>
      <div ref={box} className="browser-dock-view" data-view={!visible ? "closed" : shown ? "shown" : "suspended"}>
        {visible && !shown && <Typography.Text type="secondary">浏览器已暂时隐藏，关闭弹窗后恢复</Typography.Text>}
        {!visible && (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<>
            <div>AI 生成和试跑时，被测页面会显示在这里</div>
            <Typography.Text type="secondary">也可以先手动打开，确认登录态与页面</Typography.Text>
          </>}>
            {url && <Button icon={<ChromeOutlined />} onClick={() => void api().openTestPage(url, session)}>打开被测页面</Button>}
          </Empty>
        )}
      </div>
    </div>
  );
}
