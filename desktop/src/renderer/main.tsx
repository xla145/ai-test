import { App as AntApp, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import type { GlobalSettingsView } from "../shared/ipc";
import { SETTINGS_EVENT } from "./pages/SettingsPage";
import { api } from "./api";
import { consoleTheme, useSystemTheme } from "./theme";
import "./styles.css";

type ThemeMode = "system" | "light" | "dark";

/** 全局设置中的主题：启动时读取，设置页保存后通过事件立即切换 */
function useThemeMode(): ThemeMode {
  const [mode, setMode] = useState<ThemeMode>("system");
  useEffect(() => {
    let stale = false;
    api().getGlobalSettings().then((v) => { if (!stale) setMode(v.settings.general.theme); }, () => undefined);
    const on = (e: Event) => { stale = true; setMode((e as CustomEvent<GlobalSettingsView>).detail.settings.general.theme); };
    window.addEventListener(SETTINGS_EVENT, on);
    return () => { stale = true; window.removeEventListener(SETTINGS_EVENT, on); };
  }, []);
  return mode;
}

function Root() {
  const mode = useThemeMode();
  const dark = useSystemTheme(mode);
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
