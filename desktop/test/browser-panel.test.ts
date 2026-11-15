import { describe, expect, it } from "vitest";
import { browserPanelBounds } from "../src/shared/browserPanel";

describe("右侧浏览器边界", () => {
  it.each([[1440, 900], [933, 622], [696, 622]])("在 %ix%i 窗口中避开工具栏并保留边距", (w, h) => {
    const b = browserPanelBounds(w, h);
    expect(b.x).toBe(Math.floor(w / 2) + 12);
    expect(b.y).toBe(52);
    expect(b.x + b.width).toBe(w - 12);
    expect(b.y + b.height).toBe(h - 12);
  });
  it("极小窗口不产生负尺寸", () => {
    const b = browserPanelBounds(20, 20);
    expect(b.width).toBe(0);
    expect(b.height).toBe(0);
  });
});
