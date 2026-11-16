/** 右侧原生网页与渲染层外框共用的布局尺寸（逻辑像素）。 */
export const BROWSER_PANEL_HEADER = 52;
export const BROWSER_PANEL_GUTTER = 12;
export function browserPanelBounds(width: number, height: number) {
  const left = Math.floor(width / 2);
  return {
    x: left + BROWSER_PANEL_GUTTER,
    y: BROWSER_PANEL_HEADER,
    width: Math.max(0, width - left - BROWSER_PANEL_GUTTER * 2),
    height: Math.max(0, height - BROWSER_PANEL_HEADER - BROWSER_PANEL_GUTTER),
  };
}
