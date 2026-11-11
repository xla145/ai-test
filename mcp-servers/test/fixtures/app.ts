import { createServer, type Server } from "node:http";

/** 模拟被测系统：登录、角色菜单、标签停用、埋点上报。version=2 模拟页面改版（按钮 testid 变了） */
export interface DemoApp {
  url: string;
  state: { version: 1 | 2; beacons: unknown[]; disabled: Set<string>; onDisable?: (tag: string) => void };
  close(): Promise<void>;
}

const USERS: Record<string, { password: string; role: string }> = {
  alice: { password: "pw-admin", role: "admin" },
  bob: { password: "pw-viewer", role: "viewer" },
};

const page = (title: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>.missing{color:#999}</style></head><body>${body}</body></html>`;

export async function startDemoApp(): Promise<DemoApp> {
  const state: DemoApp["state"] = { version: 1, beacons: [], disabled: new Set() };
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const role = /session=(\w+)/.exec(req.headers.cookie ?? "")?.[1];
    const send = (code: number, html: string, headers: Record<string, string> = {}) => {
      res.writeHead(code, { "content-type": "text/html; charset=utf-8", ...headers });
      res.end(html);
    };
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (url.pathname === "/login" && req.method === "GET") {
        return send(200, page("登录", `<form method="post" action="/login">
          <label for="username">用户名</label><input id="username" name="username">
          <label for="password">密码</label><input id="password" name="password" type="password">
          <button id="login" type="submit">登录</button></form>`));
      }
      if (url.pathname === "/login" && req.method === "POST") {
        const f = new URLSearchParams(body);
        const u = USERS[f.get("username") ?? ""];
        if (!u || u.password !== f.get("password")) return send(401, page("登录失败", "<p>账号或密码错误</p>"));
        return send(302, "", { location: "/dashboard", "set-cookie": `session=${u.role}; Path=/; HttpOnly` });
      }
      if (url.pathname === "/track" && req.method === "POST") {
        state.beacons.push(JSON.parse(body));
        res.writeHead(204).end();
        return;
      }
      if (url.pathname.startsWith("/api/tags/") && req.method === "POST") {
        if (role !== "admin") return send(403, "forbidden");
        state.disabled.add(url.pathname.split("/")[3]);
        state.onDisable?.(url.pathname.split("/")[3]);
        res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
        return;
      }
      if (!role) return send(302, "", { location: "/login" });
      if (url.pathname === "/dashboard") {
        return send(200, page("综合总览", `<h1>综合总览</h1><nav>
          ${role === "admin" ? '<a href="/tags" data-testid="menu-tags">标签管理</a>' : ""}
          <a href="/profile">个人中心</a></nav><p>当前角色：<span data-testid="current-role">${role}</span></p>
          <p>今天是 <span id="today"></span></p>
          <script>document.getElementById("today").textContent = new Date().toISOString().slice(0, 10);</script>`));
      }
      if (url.pathname === "/tags") {
        if (role !== "admin") return send(403, page("无权限", "<p>无权限</p>"));
        const tid = state.version === 1 ? "disable-TAG-1001" : "tag-disable-btn-TAG-1001";
        const label = state.version === 1 ? "停用" : "停用标签";
        const status = state.disabled.has("TAG-1001") ? "已停用" : "启用中";
        return send(200, page("标签管理", `<h1>标签管理</h1>
          <input placeholder="搜索标签" aria-label="搜索标签">
          <table><tr><td>TAG-1001</td><td><span data-testid="status-TAG-1001">${status}</span></td>
          <td><button data-testid="${tid}">${label}</button></td></tr></table>
          <p class="missing" data-testid="missing-cell">--</p>
          <script>
            document.querySelector('[data-testid="${tid}"]').addEventListener("click", async () => {
              navigator.sendBeacon("/track", JSON.stringify({ events: [{ event: "click", element: "disable", client_type: "web", tag: "TAG-1001" }] }));
              await fetch("/api/tags/TAG-1001/disable", { method: "POST" });
              document.querySelector('[data-testid="status-TAG-1001"]').textContent = "已停用";
            });
          </script>`));
      }
      send(404, page("404", "not found"));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}
