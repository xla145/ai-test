import { useCallback, useEffect, useState } from "react";
import type { ApprovalRequest } from "../shared/ipc";
import { OpsPanel } from "./OpsPanel";
import { UiPanel } from "./UiPanel";
import { api, LEVEL_LABEL, MODE_LABEL, STATUS_LABEL, type LintIssue, type Project, type TestCase } from "./api";

type Tab = "import" | "cases" | "api" | "run" | "ui" | "ops";

function useAsync() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError("");
    try {
      return await fn();
    } catch (e) {
      setError((e as Error).message);
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run };
}

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [current, setCurrent] = useState<Project>();
  const [tab, setTab] = useState<Tab>("import");
  const [approval, setApproval] = useState<ApprovalRequest>();
  const [events, setEvents] = useState<string[]>([]);

  const reload = useCallback(async () => {
    const list = (await api().listProjects()) as Project[];
    setProjects(list);
    setCurrent((c) => list.find((p) => p.id === c?.id) ?? list[0]);
  }, []);

  useEffect(() => {
    void reload();
    const offA = api().onApprovalRequest(setApproval);
    const offE = api().onEvent((e) => setEvents((xs) => [...xs.slice(-199), e.method]));
    return () => {
      offA();
      offE();
    };
  }, [reload]);

  return (
    <div className="layout">
      <aside>
        <h1>AI 测试客户端</h1>
        {projects.map((p) => (
          <button key={p.id} className={`project ${p.id === current?.id ? "active" : ""}`} onClick={() => setCurrent(p)}>
            {p.name}
          </button>
        ))}
        <NewProject onCreated={reload} />
        <h2>Agent 事件</h2>
        <div className="muted" style={{ fontSize: 12 }}>
          {events.slice(-8).map((e, i) => (
            <div key={i}>{e}</div>
          ))}
        </div>
      </aside>
      <main>
        {current ? (
          <>
            <div className="tabs">
              {(
                [
                  ["import", "用例导入与规范检查"],
                  ["cases", "用例库"],
                  ["api", "接口测试"],
                  ["run", "接口回归"],
                  ["ui", "UI 测试"],
                  ["ops", "工程化"],
                ] as [Tab, string][]
              ).map(([k, label]) => (
                <button key={k} className={tab === k ? "active" : ""} onClick={() => setTab(k)}>
                  {label}
                </button>
              ))}
            </div>
            {tab === "import" && <ImportPanel project={current} />}
            {tab === "cases" && <CasesPanel project={current} />}
            {tab === "api" && <ApiPanel project={current} />}
            {tab === "run" && <RunPanel project={current} />}
            {tab === "ui" && <UiPanel key={current.id} project={current} />}
            {tab === "ops" && <OpsPanel key={current.id} project={current} />}
          </>
        ) : (
          <p className="muted">先在左侧新建项目。</p>
        )}
      </main>
      {approval && (
        <div className="modal">
          <div>
            <h2>需要你的审批</h2>
            <p>{approval.reason}</p>
            <pre>{JSON.stringify(approval.detail, null, 2)}</pre>
            <div className="row">
              <button className="primary" onClick={() => { api().respondApproval(approval.id, true); setApproval(undefined); }}>允许</button>
              <button onClick={() => { api().respondApproval(approval.id, false); setApproval(undefined); }}>拒绝</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function NewProject({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const { busy, error, run } = useAsync();
  return (
    <div style={{ marginTop: 12 }}>
      <h2>新建项目</h2>
      <input placeholder="项目名" value={name} onChange={(e) => setName(e.target.value)} style={{ width: "100%", marginBottom: 4 }} />
      <input placeholder="测试环境地址" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} style={{ width: "100%", marginBottom: 4 }} />
      <button
        disabled={!name || busy}
        onClick={() =>
          run(async () => {
            const dir = await api().pickDirectory();
            if (!dir) return;
            await api().createProject(name, dir, baseUrl ? { test: { base_url: baseUrl } } : {});
            setName("");
            onCreated();
          })
        }
      >
        选择 workspace 并创建
      </button>
      {error && <div className="error">{error}</div>}
    </div>
  );
}

function ImportPanel({ project }: { project: Project }) {
  const [report, setReport] = useState<any>();
  const { busy, error, run } = useAsync();
  const issues: LintIssue[] = report?.issues ?? [];
  return (
    <section>
      <div className="row">
        <button
          className="primary"
          disabled={busy}
          onClick={() =>
            run(async () => {
              const file = await api().pickFile([{ name: "Excel", extensions: ["xlsx"] }]);
              if (!file) return;
              await api().importExcel(project.id, file);
              setReport(await api().lint(project.id));
            })
          }
        >
          导入 Excel 用例
        </button>
        <button disabled={busy} onClick={() => run(async () => setReport(await api().lint(project.id)))}>
          重新检查
        </button>
        {busy && <span className="muted">处理中…</span>}
      </div>
      {error && <div className="error">{error}</div>}
      {report && (
        <>
          <div className="stats">
            <div className="stat"><b>{report.total}</b>用例</div>
            <div className="stat"><b>{report.blocked_case_ids.length}</b>阻断</div>
            <div className="stat"><b>{((report.stats?.p0_ratio ?? 0) * 100).toFixed(1)}%</b>P0 占比</div>
          </div>
          <h2>规则命中</h2>
          <table>
            <thead><tr><th>规则</th><th>命中用例数</th></tr></thead>
            <tbody>
              {Object.entries(report.rule_hits as Record<string, number>).map(([rule, n]) => (
                <tr key={rule}><td>{rule}</td><td>{n}</td></tr>
              ))}
            </tbody>
          </table>
          <h2>问题明细（前 200 条）</h2>
          <table>
            <thead><tr><th>级别</th><th>问题</th><th>建议</th></tr></thead>
            <tbody>
              {issues.slice(0, 200).map((i) => (
                <tr key={i.id}>
                  <td><span className={`tag ${i.level}`}>{LEVEL_LABEL[i.level] ?? i.level}</span></td>
                  <td>{i.message}<div className="muted">{i.case_id}</div></td>
                  <td>{i.suggestion}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

function CasesPanel({ project }: { project: Project }) {
  const [cases, setCases] = useState<TestCase[]>([]);
  const [mode, setMode] = useState("");
  const { busy, error, run } = useAsync();
  const load = useCallback(
    () => run(async () => setCases((await api().listCases(project.id, mode ? { execution_mode: mode } : {})) as TestCase[])),
    [project.id, mode, run],
  );
  useEffect(() => void load(), [load]);
  return (
    <section>
      <div className="row">
        <select value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="">全部执行方式</option>
          {Object.entries(MODE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <span className="muted">{cases.length} 条</span>
      </div>
      {error && <div className="error">{error}</div>}
      <table>
        <thead><tr><th>标题</th><th>等级</th><th>执行方式</th><th>规范</th><th>状态</th><th /></tr></thead>
        <tbody>
          {cases.map((c) => (
            <tr key={c.id}>
              <td>{c.title}<div className="muted">{c.module_path.join(" / ")}</div></td>
              <td>{c.priority}</td>
              <td>{MODE_LABEL[c.execution_mode] ?? c.execution_mode}</td>
              <td><span className={`tag ${c.lint_status}`}>{c.lint_status}</span></td>
              <td>{STATUS_LABEL[c.status] ?? c.status}</td>
              <td>
                {c.status === "draft" && (
                  <button disabled={busy} onClick={() => run(async () => { await api().updateCase(c.id, { status: "reviewed" }, "human"); await load(); })}>
                    审核通过
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function ApiPanel({ project }: { project: Project }) {
  const [result, setResult] = useState<unknown>();
  const [enrich, setEnrich] = useState(false);
  const { busy, error, run } = useAsync();
  return (
    <section>
      <p className="muted">接口测试是一期主线：从 OpenAPI 生成基线用例（正向、必填缺失、边界值、类型错误、鉴权、幂等）和数据驱动的 pytest 脚本。</p>
      <div className="row">
        <label><input type="checkbox" checked={enrich} onChange={(e) => setEnrich(e.target.checked)} /> 让 agent 补充业务场景（消耗模型）</label>
        <button
          className="primary"
          disabled={busy}
          onClick={() =>
            run(async () => {
              const file = await api().pickFile([{ name: "OpenAPI", extensions: ["json", "yaml", "yml"] }]);
              if (file) setResult(await api().generateApiSuite(project.id, file, enrich));
            })
          }
        >
          选择 OpenAPI 并生成
        </button>
        <button
          disabled={busy}
          onClick={() =>
            run(async () => {
              const file = await api().pickFile([{ name: "需求文档", extensions: ["md", "docx", "pdf", "txt"] }]);
              if (file) setResult(await api().generateCases(project.id, file));
            })
          }
        >
          从需求文档生成用例（agent）
        </button>
        {busy && <span className="muted">处理中…</span>}
      </div>
      {error && <div className="error">{error}</div>}
      {result !== undefined && <pre>{JSON.stringify(result, null, 2)}</pre>}
    </section>
  );
}

function RunPanel({ project }: { project: Project }) {
  const envs = Object.keys(project.environments);
  const [env, setEnv] = useState(envs[0] ?? "");
  const [token, setToken] = useState("");
  const [result, setResult] = useState<any>();
  const [usage, setUsage] = useState<number>();
  const { busy, error, run } = useAsync();
  useEffect(() => void api().tokenUsage(project.id).then((u) => setUsage(u.tokens)), [project.id, result]);
  return (
    <section>
      <div className="row">
        <select value={env} onChange={(e) => setEnv(e.target.value)}>
          {envs.map((e) => <option key={e} value={e}>{e}（{project.environments[e].base_url}）</option>)}
        </select>
        <input type="password" placeholder="鉴权 token（存入系统钥匙串）" value={token} onChange={(e) => setToken(e.target.value)} />
        <button disabled={!token || !env} onClick={() => run(async () => { await api().setEnvSecret(project.id, env, token); setToken(""); })}>
          保存凭据
        </button>
      </div>
      <div className="row">
        <button className="primary" disabled={!env || busy} onClick={() => run(async () => setResult(await api().runRegression(project.id, env)))}>
          执行回归
        </button>
        <button disabled={!env} onClick={() => api().openTestPage(project.environments[env].base_url)}>在内嵌浏览器打开</button>
        <span className="muted">项目累计模型消耗：{usage ?? "-"} tokens</span>
      </div>
      {error && <div className="error">{error}</div>}
      {result && (
        <>
          <div className="stats">
            <div className="stat"><b>{result.run.total}</b>总数</div>
            <div className="stat"><b>{result.run.passed}</b>通过</div>
            <div className="stat"><b>{result.run.failed + result.run.error}</b>失败</div>
            <div className="stat"><b>{(result.run.pass_rate * 100).toFixed(1)}%</b>通过率</div>
          </div>
          {result.triage && (
            <>
              <h2>失败归因</h2>
              <table>
                <thead><tr><th>用例</th><th>类型</th><th>原因</th><th>建议</th></tr></thead>
                <tbody>
                  {result.triage.map((t: any) => (
                    <tr key={t.case_id}><td>{t.case_id}</td><td><span className="tag failed">{t.failure_type}</span></td><td>{t.reason}</td><td>{t.suggestion}</td></tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}
    </section>
  );
}
