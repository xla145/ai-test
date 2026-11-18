import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

function bridge() {
  const exposed: Record<string, Record<string, any>> = {};
  const ipcRenderer = {
    invoke: vi.fn(async (_channel: string, ..._args: unknown[]) => ({ ok: true })),
    send: vi.fn(),
    on: vi.fn((_channel: string, _listener: (event: unknown, data: unknown) => void) => {}),
    removeListener: vi.fn(),
  };
  const { outputText } = ts.transpileModule(readFileSync(new URL("../src/preload/index.cts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  runInNewContext(outputText, {
    exports: {}, process: { platform: "darwin" },
    require: (name: string) => {
      if (name !== "electron") throw new Error(`Unexpected runtime preload dependency: ${name}`);
      return { ipcRenderer, contextBridge: { exposeInMainWorld: (key: string, value: Record<string, any>) => { exposed[key] = value; } } };
    },
  });
  return { api: exposed.aitest, ipcRenderer, exposed };
}

describe("sandbox preload performance bridge", () => {
  it.each([
    ["perfCompile", ["project", "case"]],
    ["perfSetBaseline", ["project", "GET:/health", "perf-run"]],
    ["perfGetBaseline", ["project", "GET:/health"]],
    ["perfTrend", ["project", "/health"]],
  ] as const)("exposes %s and forwards the exact arguments", async (method, args) => {
    const { api, ipcRenderer } = bridge();
    expect(typeof api[method]).toBe("function");
    await expect(api[method](...args)).resolves.toEqual({ ok: true });
    expect(ipcRenderer.invoke).toHaveBeenCalledWith("aitest:invoke", method, ...args);
  });

  it("propagates baseline errors rather than hiding them", async () => {
    const { api, ipcRenderer } = bridge();
    ipcRenderer.invoke.mockRejectedValueOnce(new Error("只能将已通过的结果设为基线"));
    await expect(api.perfSetBaseline("p", "GET:/health", "perf-bad")).rejects.toThrow("已通过");
  });

  it("does not expose arbitrary IPC and retains existing event subscriptions", () => {
    const { api, ipcRenderer, exposed } = bridge();
    expect(api.ipcRenderer).toBeUndefined();
    expect(api.invoke).toBeUndefined();
    expect(exposed.desktopHost.platform).toBe("darwin");
    const callback = vi.fn();
    const stop = api.onEvent(callback);
    const [channel, listener] = ipcRenderer.on.mock.calls[0];
    expect(channel).toBe("aitest:event");
    listener({}, { name: "event" });
    expect(callback).toHaveBeenCalledWith({ name: "event" });
    stop();
    expect(ipcRenderer.removeListener).toHaveBeenCalledWith(channel, listener);
  });
});
