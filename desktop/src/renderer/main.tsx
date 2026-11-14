import { App as AntApp, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import type { GlobalSettingsView } from "../shared/ipc";
import { SETTINGS_EVENT } from "./pages/SettingsPage";
import { consoleTheme } from "./theme";
import "./styles.css";

function usePrefersDark(): boolean {
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  const [dark, setDark] = useState(query.matches);
  useEffect(() => {
    const on = (e: MediaQueryListEvent) => setDark(e.matches);
    query.addEventListener("change", on);
    return () => query.removeEventListener("change", on);
  }, [query]);
  return dark;
}

type ThemeMode = "system" | "light" | "dark";

/** 全局设置中的主题：启动时读取，设置页保存后通过事件立即切换 */
function useThemeMode(): ThemeMode {
  const [mode, setMode] = useState<ThemeMode>("system");
  useEffect(() => {
    window.aitest.getGlobalSettings().then((v) => setMode(v.settings.general.theme), () => undefined);
    const on = (e: Event) => setMode((e as CustomEvent<GlobalSettingsView>).detail.settings.general.theme);
    window.addEventListener(SETTINGS_EVENT, on);
    return () => window.removeEventListener(SETTINGS_EVENT, on);
  }, []);
  return mode;
}

function Root() {
  const prefersDark = usePrefersDark();
  const mode = useThemeMode();
  const dark = mode === "system" ? prefersDark : mode === "dark";
  useEffect(() => { document.documentElement.dataset.theme = dark ? "dark" : "light"; }, [dark]);
  return (
    <ConfigProvider
      locale={zhCN}
      theme={consoleTheme(dark)}
    >
      <AntApp>
        <App />
      </AntApp>
    </ConfigProvider>
  );
}

async function start() {
  // 在普通浏览器中预览界面（没有 Electron 预加载脚本）时，使用演示数据
  if (!window.aitest) await import("./mock").then((m) => m.installMock());
  createRoot(document.getElementById("root")!).render(<Root />);
}

void start();
