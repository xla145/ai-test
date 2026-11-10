import { useCallback, useEffect, useState } from "react";
import { api, MODE_LABEL, type Project, type TestCase } from "./api";

interface Proposal { id: string; case_id: string; script_path: string; diff: string; reason: string; status: string }
interface Review { id: string; case_id: string; kind: string; description: string; ai_verdict: string; evidence_paths: string[]; status: string }

function useBusy() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run };
}

/** 二期：UI 测试（探索 / 回归 / 自愈）、多角色、人工复核队列 */
export function UiPanel({ project }: { project: Project }) {
  const envs = Object.keys(project.environments);
  const [env, setEnv] = useState(envs[0] ?? "");
  const [cases, setCases] = useState<TestCase[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [result, setResult] = useState<any>();
  const [headed, setHeaded] = useState(true);
  const [role, setRole] = useState({ name: "", username: "", password: "" });
  const [login, setLogin] = useState(JSON.stringify((project.environments[env] as any)?.login ?? {
    url: "/login", username: "#username", password: "#password", submit: "button[type=submit]", success: "/",
  }, null, 2));
  const { busy, error, run } = useBusy();

  const reload = useCallback(async () => {
    setCases((await api().listCases(project.id)) as TestCase[]);
    setRoles((await api().listRoles(project.id)).map((r) => r.role_name));
    setProposals((await api().listProposals("pending")) as Proposal[]);
    setReviews((await api().listReviews("pending")) as Review[]);
  }, [project.id]);
  useEffect(() => void reload(), [reload]);

  const uiCases = cases.filter((c) => ["ui", "capture"].includes(c.execution_mode) && c.status !== "deprecated");

  return (
    <section>
      <div className="row">
        <select value={env} onChange={(e) => setEnv(e.target.value)}>
          {envs.map((e) => <option key={e} value={e}>{e}</option>)}
        </select>
        <label><input type="checkbox" checked={headed} onChange={(e) => setHeaded(e.target.checked)} /> 可视化执行</label>
        <button className="primary" disabled={!env || busy} onClick={() => run(async () => { setResult(await api().runUiRegression(project.id, env, headed)); await reload(); })}>
          执行 UI 回归
        </button>
        {busy && <span className="muted">处理中…</span>}
      </div>
      {error && <div className="error">{error}</div>}

      {result && (
        <div className="stats" style={{ marginBottom: 12 }}>
          <div className="stat"><b>{result.run.total}</b>总数</div>
          <div className="stat"><b>{result.run.passed}</b>通过</div>
          <div className="stat"><b>{result.run.failed + result.run.error}</b>失败</div>
          <div className="stat"><b>{result.run.reviews}</b>待复核</div>
          <div className="stat"><b>{result.degraded.length}</b>降级手工</div>
        </div>
      )}

      <h2>脚本修改建议（自愈，需确认后合并）</h2>
      {proposals.length === 0 && <p className="muted">暂无</p>}
      {proposals.map((p) => (
        <div key={p.id} style={{ marginBottom: 12 }}>
          <div className="row"><b>{p.case_id}</b><span className="muted">{p.reason}</span></div>
          <pre>{p.diff}</pre>
          <div className="row">
            <button className="primary" disabled={busy} onClick={() => run(async () => { await api().resolveProposal(project.id, p.id, true); await reload(); })}>合并</button>
            <button disabled={busy} onClick={() => run(async () => { await api().resolveProposal(project.id, p.id, false); await reload(); })}>拒绝</button>
          </div>
        </div>
      ))}

      <h2>人工复核队列（AI 判定）</h2>
      <table>
        <thead><tr><th>用例</th><th>判定内容</th><th>AI 结论</th><th>证据</th><th /></tr></thead>
        <tbody>
          {reviews.map((r) => (
            <tr key={r.id}>
              <td>{r.case_id}</td>
              <td>{r.description}</td>
              <td>{r.ai_verdict || "未判定"}</td>
              <td className="muted">{r.evidence_paths.join(", ")}</td>
              <td>
                <button disabled={busy} onClick={() => run(async () => { await api().resolveReview(r.id, true); await reload(); })}>通过</button>
                <button disabled={busy} onClick={() => run(async () => { await api().resolveReview(r.id, false); await reload(); })}>不通过</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>UI 用例（探索模式生成脚本）</h2>
      <table>
        <thead><tr><th>标题</th><th>执行方式</th><th>规范</th><th /></tr></thead>
        <tbody>
          {uiCases.map((c) => (
            <tr key={c.id}>
              <td>{c.title}</td>
              <td>{MODE_LABEL[c.execution_mode]}</td>
              <td><span className={`tag ${c.lint_status}`}>{c.lint_status}</span></td>
              <td>
                <button disabled={busy || c.lint_status === "blocked"} onClick={() => run(async () => { setResult(undefined); await api().exploreUiCase(project.id, env, c.id); await reload(); })}>
                  探索并生成脚本
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>角色账号（存入系统钥匙串，用例只写角色名）</h2>
      <p className="muted">已配置：{roles.join("、") || "无"}</p>
      <div className="row">
        <input placeholder="角色名" value={role.name} onChange={(e) => setRole({ ...role, name: e.target.value })} />
        <input placeholder="账号" value={role.username} onChange={(e) => setRole({ ...role, username: e.target.value })} />
        <input type="password" placeholder="密码" value={role.password} onChange={(e) => setRole({ ...role, password: e.target.value })} />
        <button disabled={!role.name || !role.username || !role.password || busy}
          onClick={() => run(async () => { await api().setRoleSecret(project.id, role.name, role.username, role.password); setRole({ name: "", username: "", password: "" }); await reload(); })}>
          保存角色
        </button>
      </div>
      <h2>登录方式（{env} 环境，选择器）</h2>
      <textarea value={login} onChange={(e) => setLogin(e.target.value)} rows={7} style={{ width: "100%", fontFamily: "monospace" }} />
      <button disabled={busy || !env}
        onClick={() => run(async () => { await api().setEnvironment(project.id, env, { ...project.environments[env], login: JSON.parse(login) }); })}>
        保存登录方式
      </button>
    </section>
  );
}
