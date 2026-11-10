import { App as AntApp, ConfigProvider, theme } from "antd";
import zhCN from "antd/locale/zh_CN";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
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

function Root() {
  const dark = usePrefersDark();
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: { colorPrimary: "#3b6ef5", borderRadius: 8, fontSize: 14 },
        components: { Layout: { siderBg: dark ? "#141414" : "#ffffff", headerBg: dark ? "#141414" : "#ffffff" } },
      }}
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
