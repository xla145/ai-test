import { useCallback, useEffect, useState } from "react";
import { api, type Project } from "./api";

/** 三期：自愈与工程化——用量与预算、验证指标与门禁、归因确认、模型配置、团队共享与 CI */
const TYPE_LABEL: Record<string, string> = { product_bug: "产品缺陷", script_error: "脚本 / 页面改版", environment: "环境问题" };
const PURPOSE_LABEL: Record<string, string> = { case_gen: "用例生成", api_script: "接口脚本", triage: "失败归因", explore: "UI 探索", heal: "自愈" };
const pct = (v: number | null | undefined) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);

function useBusy() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const run = useCallback(async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    setError("");
    setNote("");
    try {
      await fn();
      if (ok) setNote(ok);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, note, run };
}

export function OpsPanel({ project }: { project: Project }) {
  const [usage, setUsage] = useState<any>();
  const [budget, setBudget] = useState<any>();
  const [settings, setSettings] = useState<Record<string, any>>({});
  const [metrics, setMetrics] = useState<any>();
  const [attributions, setAttributions] = useState<any[]>([]);
  const { busy, error, note, run } = useBusy();

  const reload = useCallback(async () => {
    const [u, b, s, m, a] = await Promise.all([
      api().usageReport(project.id, 30), api().checkBudget(project.id), api().getSettings(project.id),
      api().metrics(project.id), api().listAttributions(project.id, true),
    ]);
    setUsage(u);
    setBudget(b);
    setSettings(s);
    setMetrics(m);
    setAttributions(a);
  }, [project.id]);
  useEffect(() => void reload(), [reload]);

  return (
    <section>
      {error && <div className="error">{error}</div>}
      {note && <div className="muted">{note}</div>}

      <h2>验证指标（首期验证方案）</h2>
      {metrics && (
        <div className="stats">
          <div className="stat"><b>{pct(metrics.first_pass_rate)}</b>一次生成通过率（{metrics.first_pass.passed}/{metrics.first_pass.measured}）</div>
          <div className="stat"><b>{pct(metrics.attribution_accuracy)}</b>失败归因准确率（{metrics.attribution.correct}/{metrics.attribution.confirmed}）</div>
          <div className="stat"><b>{metrics.interventions_per_case ?? "—"}</b>每条用例人工介入次数</div>
          <div className="stat">
            <b className={metrics.ui_gate.passed ? "tag passed" : "tag failed"}>{metrics.ui_gate.passed ? "已达标" : "未达标"}</b>
            门禁：UI 回归稳定（近 {metrics.ui_gate.runs} 次平均 {pct(metrics.ui_gate.avg_pass_rate)}）
          </div>
        </div>
      )}
      {metrics?.ui_gate.reasons.length > 0 && <p className="muted">{metrics.ui_gate.reasons.join("；")}</p>}

      <h2>待确认的失败归因（{attributions.length}）</h2>
      <p className="muted">确认后以人工结论为准，并计入归因准确率。</p>
      <table>
        <thead><tr><th>用例</th><th>自动归因</th><th>依据</th><th>人工确认</th></tr></thead>
        <tbody>
          {attributions.slice(0, 50).map((a) => (
            <tr key={`${a.run_id}/${a.case_id}`}>
              <td>{a.case_id}<div className="muted">{a.run_id}</div></td>
              <td>{TYPE_LABEL[a.auto_type] ?? a.auto_type}<div className="muted">{a.source === "rule" ? "规则" : "agent"}</div></td>
              <td>{a.reason}</td>
              <td>
                {Object.entries(TYPE_LABEL).map(([k, v]) => (
                  <button key={k} disabled={busy} onClick={() => run(async () => { await api().confirmAttribution(a.run_id, a.case_id, k); await reload(); })}>{v}</button>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>模型用量（近 30 天）</h2>
      {usage && (
        <>
          <div className="stats">
            <div className="stat"><b>{usage.total_tokens.toLocaleString()}</b>tokens（{usage.agent_tasks} 个 agent 任务）</div>
            <div className="stat"><b>{usage.estimated_cost ?? "—"}</b>估算成本 {usage.currency}</div>
            <div className="stat"><b>{budget?.monthly_budget ? `${budget.month_used.toLocaleString()} / ${budget.monthly_budget.toLocaleString()}` : "不限"}</b>本月预算{budget?.allowed === false ? "（已用完）" : ""}</div>
          </div>
          <table style={{ marginTop: 8 }}>
            <thead><tr><th>用途</th><th>tokens</th></tr></thead>
            <tbody>
              {Object.entries(usage.by_purpose as Record<string, number>).map(([k, v]) => (
                <tr key={k}><td>{PURPOSE_LABEL[k] ?? k}</td><td>{v.toLocaleString()}</td></tr>
              ))}
            </tbody>
          </table>
          <p className="muted">日常回归直接跑脚本，不消耗模型；只有新增用例、页面变动和原因不明的失败才调用 agent。</p>
        </>
      )}
      <BudgetForm project={project} settings={settings} busy={busy} onSave={(s) => run(async () => { await api().setSettings(project.id, s); await reload(); }, "已保存")} />

      <h2>团队共享与 CI</h2>
      <SharePanel project={project} busy={busy} run={run} />

      <h2>模型服务（国内模型 / 私有化部署）</h2>
      <ModelPanel busy={busy} run={run} />
    </section>
  );
}

function BudgetForm({ settings, busy, onSave }: { project: Project; settings: Record<string, any>; busy: boolean; onSave: (s: Record<string, string>) => void }) {
  const [form, setForm] = useState<Record<string, string>>({});
  useEffect(() => setForm(Object.fromEntries(Object.entries(settings).map(([k, v]) => [k, String(v)]))), [settings]);
  const field = (key: string, label: string, placeholder = "") => (
    <label style={{ display: "inline-flex", flexDirection: "column", marginRight: 8 }}>
      <span className="muted" style={{ fontSize: 12 }}>{label}</span>
      <input value={form[key] ?? ""} placeholder={placeholder} onChange={(e) => setForm({ ...form, [key]: e.target.value })} style={{ width: 140 }} />
    </label>
  );
  return (
    <div className="row" style={{ alignItems: "flex-end" }}>
      {field("monthly_token_budget", "月度 token 上限", "不限")}
      {field("per_task_token_limit", "单次任务上限", "不限")}
      {field("price_per_mtok", "每百万 token 价格")}
      {field("currency", "币种", "CNY")}
      {field("stability_threshold", "门禁通过率", "0.95")}
      <button disabled={busy} onClick={() => onSave(form)}>保存</button>
    </div>
  );
}

function SharePanel({ project, busy, run }: { project: Project; busy: boolean; run: (fn: () => Promise<unknown>, ok?: string) => Promise<void> }) {
  const [toolRepo, setToolRepo] = useState("");
  const [provider, setProvider] = useState<"github" | "gitlab">("github");
  const envs = Object.keys(project.environments);
  const [env, setEnv] = useState(envs[0] ?? "test");
  return (
    <>
      <p className="muted">
        workspace 是一个 git 仓库：导出后把用例、脚本与项目配置（不含任何凭据）随 git 共享；
        成员 clone 后在客户端「导入 workspace」，CI 中用 aitest-ci 直接回归。
      </p>
      <div className="row">
        <button disabled={busy} onClick={() => run(async () => { const r = await api().exportWorkspace(project.id); return r; }, "已导出并提交到 workspace 的 git")}>
          导出到 workspace
        </button>
        <button disabled={busy} onClick={() => run(async () => { const dir = await api().pickDirectory(); if (dir) await api().importWorkspace(dir); }, "已导入")}>
          导入 workspace
        </button>
      </div>
      <div className="row">
        <select value={provider} onChange={(e) => setProvider(e.target.value as "github" | "gitlab")}>
          <option value="github">GitHub Actions</option>
          <option value="gitlab">GitLab CI</option>
        </select>
        <select value={env} onChange={(e) => setEnv(e.target.value)}>
          {envs.map((e) => <option key={e} value={e}>{e}</option>)}
        </select>
        <input placeholder="客户端仓库 git 地址（CI 从这里安装执行器）" value={toolRepo} onChange={(e) => setToolRepo(e.target.value)} style={{ flex: 1 }} />
        <button disabled={busy || !toolRepo} onClick={() => run(async () => api().initCi(project.id, provider, toolRepo, env), "已生成 CI 配置，请在 CI 的密钥中配置 AITEST_AUTH_TOKEN、AITEST_ROLES")}>
          生成 CI 配置
        </button>
      </div>
    </>
  );
}

function ModelPanel({ busy, run }: { busy: boolean; run: (fn: () => Promise<unknown>, ok?: string) => Promise<void> }) {
  const [presets, setPresets] = useState<any[]>([]);
  const [cfg, setCfg] = useState<any>();
  const [keys, setKeys] = useState({ agent: "", vision: "" });
  const [check, setCheck] = useState<Record<string, any>>({});
  useEffect(() => {
    void api().modelPresets().then(setPresets);
    void api().getModelSettings().then(setCfg);
  }, []);
  if (!cfg) return null;
  const slot = (kind: "agent" | "vision", label: string) => {
    const value = cfg[kind];
    const preset = presets.find((p) => p.id === value?.preset);
    return (
      <div style={{ marginBottom: 8 }}>
        <div className="row">
          <b style={{ width: 80 }}>{label}</b>
          <select value={value?.preset ?? ""} onChange={(e) => setCfg({ ...cfg, [kind]: e.target.value ? { preset: e.target.value } : undefined })}>
            {kind === "vision" && <option value="">不启用</option>}
            {presets.filter((p) => kind === "agent" || p.visionFamily).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          {value && (
            <>
              <input placeholder={preset?.baseUrl || "服务地址"} value={value.baseUrl ?? ""} onChange={(e) => setCfg({ ...cfg, [kind]: { ...value, baseUrl: e.target.value } })} />
              <input placeholder={(kind === "agent" ? preset?.model : preset?.visionModel) || "模型名"} value={value.model ?? ""} onChange={(e) => setCfg({ ...cfg, [kind]: { ...value, model: e.target.value } })} />
              <input type="password" placeholder={cfg[kind === "agent" ? "hasAgentKey" : "hasVisionKey"] ? "API key 已保存" : "API key"} value={keys[kind]} onChange={(e) => setKeys({ ...keys, [kind]: e.target.value })} />
              <button disabled={busy} onClick={() => run(async () => setCheck({ ...check, [kind]: await api().checkModel(kind) }))}>测试连通</button>
            </>
          )}
        </div>
        {preset && <div className="muted" style={{ fontSize: 12 }}>{preset.note}</div>}
        {check[kind] && <div className={check[kind].ok ? "muted" : "error"}>{check[kind].detail}（{check[kind].latencyMs} ms）</div>}
      </div>
    );
  };
  return (
    <>
      <p className="muted">agent 用于用例设计与失败归因，建议强模型；视觉模型只用于探索与自愈时的元素定位。API key 存系统钥匙串。</p>
      {slot("agent", "agent 模型")}
      {slot("vision", "视觉模型")}
      <button className="primary" disabled={busy} onClick={() => run(async () => {
        const { hasAgentKey: _a, hasVisionKey: _v, ...models } = cfg;
        setCfg(await api().setModelSettings(models, { agent: keys.agent || undefined, vision: keys.vision || undefined }));
        setKeys({ agent: "", vision: "" });
        setCfg(await api().getModelSettings());
      }, "已保存，下一个 agent 任务按新配置启动")}>保存模型配置</button>
    </>
  );
}
