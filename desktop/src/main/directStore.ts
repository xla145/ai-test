/**
 * 直连 SQLite 只读查询层：替代高频读操作的 Python 子进程调用。
 *
 * 设计原则：
 * - 只做**只读**查询，写操作仍走 Python 引擎（CLI）
 * - 使用 better-sqlite3 同步 API，单次查询 < 5ms（vs Python 子进程 200-500ms）
 * - 沿用数据库现有日志模式，只读连接不修改数据库配置
 * - 表不存在时优雅降级（ops 三期的表可能尚未创建）
 */

import Database from "better-sqlite3";

// --------------------------------------------------------------------------- 类型

interface ProjectRow {
  id: string;
  name: string;
  workspace_path: string;
  environments: string; // JSON
  parent_id: string;
  kind: string;
  project_type: string;
}

interface ProjectView {
  id: string;
  name: string;
  workspace_path: string;
  environments: Record<string, unknown>;
  own_environments: Record<string, unknown>;
  inherited_environments: Record<string, string>;
  parent_id: string;
  parent_name: string;
  kind: string;
  project_type: string;
  children: string[];
}

interface CaseRow {
  id: string;
  project_id: string;
  title: string;
  type: string;
  priority: string;
  execution_mode: string;
  status: string;
  lint_status: string;
  data: string; // JSON
}

// --------------------------------------------------------------------------- 辅助

/** 逗号分隔的多个值 → IN 子句 */
function matchClause(col: string, value: string): { sql: string; args: unknown[] } {
  const vals = value.split(",").filter(Boolean);
  if (vals.length === 1) return { sql: ` AND ${col}=?`, args: vals };
  return { sql: ` AND ${col} IN (${vals.map(() => "?").join(",")})`, args: vals };
}

function likePattern(text: string): string {
  return "%" + text.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_") + "%";
}

// --------------------------------------------------------------------------- DirectStore

export class DirectStore {
  private db: Database.Database;
  private tables = new Set<string>();

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { readonly: true });
    // 日志模式由写入端管理；只读连接切换到 WAL 会触发 SQLITE_READONLY。
    this.refreshTables();
  }

  /** 刷新已知表（写操作可能创建新表） */
  refreshTables(): void {
    this.tables = new Set(
      this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
        .map((r: any) => r.name as string),
    );
  }

  private hasTable(name: string): boolean {
    if (this.tables.has(name)) return true;
    // 可能在我们上次刷新后被 Python 创建
    this.refreshTables();
    return this.tables.has(name);
  }

  close(): void {
    this.db.close();
  }

  // ---- project ----

  private rawProject(id: string): ProjectRow | undefined {
    return this.db.prepare("SELECT * FROM project WHERE id=?").get(id) as ProjectRow | undefined;
  }

  private projectView(p: ProjectRow): ProjectView {
    const envs = JSON.parse(p.environments || "{}");
    const parent = p.parent_id ? this.rawProject(p.parent_id) : undefined;
    const parentEnvs = parent ? JSON.parse(parent.environments || "{}") : {};
    const inherited: Record<string, string> = {};
    for (const k of Object.keys(parentEnvs)) {
      if (!(k in envs)) inherited[k] = parent!.id;
    }
    const children = p.kind === "group"
      ? (this.db.prepare("SELECT id FROM project WHERE parent_id=? ORDER BY name").all(p.id) as { id: string }[]).map((r) => r.id)
      : [];
    return {
      id: p.id,
      name: p.name,
      workspace_path: p.workspace_path,
      environments: { ...parentEnvs, ...envs },
      own_environments: envs,
      inherited_environments: inherited,
      parent_id: p.parent_id,
      parent_name: parent?.name ?? "",
      kind: p.kind || "project",
      project_type: p.project_type,
      children,
    };
  }

  listProjects(): ProjectView[] {
    const rows = this.db.prepare("SELECT * FROM project ORDER BY name").all() as ProjectRow[];
    return rows.map((r) => this.projectView(r));
  }

  getProject(id: string): ProjectView | undefined {
    const r = this.rawProject(id);
    return r ? this.projectView(r) : undefined;
  }

  // ---- testcase ----

  private caseWhere(projectId: string, filters: Record<string, string | undefined> = {}, query?: string) {
    let sql = " WHERE project_id=?";
    const args: unknown[] = [projectId];
    for (const col of ["type", "priority", "execution_mode", "status", "lint_status"] as const) {
      if (filters[col]) {
        const m = matchClause(col, filters[col]!);
        sql += m.sql;
        args.push(...m.args);
      }
    }
    if (filters.ids) {
      const m = matchClause("id", filters.ids);
      sql += m.sql;
      args.push(...m.args);
    }
    if (filters.exclude_ids) {
      const excluded = filters.exclude_ids.split(",").filter(Boolean);
      if (excluded.length) {
        sql += ` AND id NOT IN (${excluded.map(() => "?").join(",")})`;
        args.push(...excluded);
      }
    }
    if (query) {
      sql += " AND (title LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\' OR json_extract(data, '$.module_path') LIKE ? ESCAPE '\\')";
      const p = likePattern(query);
      args.push(p, p, p);
    }
    return { sql, args };
  }

  countCases(projectId: string, filters: Record<string, string | undefined> = {}, query?: string): number {
    const w = this.caseWhere(projectId, filters, query);
    return (this.db.prepare("SELECT COUNT(*) AS n FROM testcase" + w.sql).get(...w.args) as { n: number }).n;
  }

  pageCases(projectId: string, q: {
    page: number; pageSize: number; query?: string; filters?: Record<string, string | undefined>;
  }): { items: unknown[]; total: number; page: number; page_size: number } {
    const w = this.caseWhere(projectId, q.filters, q.query);
    const total = (this.db.prepare("SELECT COUNT(*) AS n FROM testcase" + w.sql).get(...w.args) as { n: number }).n;
    const page = Math.max(q.page, 1);
    const rows = this.db.prepare(
      "SELECT data FROM testcase" + w.sql + " ORDER BY rowid LIMIT ? OFFSET ?",
    ).all(...w.args, q.pageSize, (page - 1) * q.pageSize) as { data: string }[];
    return {
      items: rows.map((r) => JSON.parse(r.data)),
      total,
      page,
      page_size: q.pageSize,
    };
  }

  listCases(projectId: string, filters: Record<string, string | undefined> = {}): unknown[] {
    const w = this.caseWhere(projectId, filters);
    const rows = this.db.prepare("SELECT data FROM testcase" + w.sql + " ORDER BY rowid").all(...w.args) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data));
  }

  getCase(caseId: string): unknown | undefined {
    const r = this.db.prepare("SELECT data FROM testcase WHERE id=?").get(caseId) as { data: string } | undefined;
    return r ? JSON.parse(r.data) : undefined;
  }

  caseTitles(projectId: string, ids: string[]): Record<string, string> {
    if (!ids.length) return {};
    const stmt = this.db.prepare("SELECT id, title FROM testcase WHERE id=?");
    const result: Record<string, string> = {};
    for (const id of ids) {
      const r = stmt.get(id) as { id: string; title: string } | undefined;
      if (r) result[r.id] = r.title;
    }
    return result;
  }

  // ---- lint_issue ----

  pageIssues(projectId: string, q: { page: number; pageSize: number; level?: string }): {
    items: unknown[]; total: number; page: number; page_size: number; levels: Record<string, number>;
  } {
    const ofProject = " AND case_id IN (SELECT id FROM testcase WHERE project_id=?)";
    let where = " WHERE 1=1" + ofProject;
    const args: unknown[] = [projectId];
    if (q.level) {
      const m = matchClause("level", q.level);
      where += m.sql;
      args.push(...m.args);
    }
    const total = (this.db.prepare("SELECT COUNT(*) AS n FROM lint_issue" + where).get(...args) as { n: number }).n;
    const page = Math.max(q.page, 1);
    const rows = this.db.prepare(
      "SELECT * FROM lint_issue" + where + " ORDER BY rowid LIMIT ? OFFSET ?",
    ).all(...args, q.pageSize, (page - 1) * q.pageSize) as any[];
    // 级别统计（不受级别筛选影响）
    const levelRows = this.db.prepare(
      "SELECT level, COUNT(*) AS n FROM lint_issue WHERE 1=1" + ofProject + " GROUP BY level",
    ).all(projectId) as { level: string; n: number }[];
    const levels: Record<string, number> = {};
    for (const r of levelRows) levels[r.level] = r.n;
    return {
      items: rows.map((r) => ({ ...r, resolved: Boolean(r.resolved) })),
      total, page, page_size: q.pageSize, levels,
    };
  }

  // ---- heal_proposal (UI 脚本修改建议) ----

  pageProposals(projectId: string, q: { page: number; pageSize: number; status?: string }): {
    items: unknown[]; total: number; page: number; page_size: number;
  } {
    const ofProject = " AND case_id IN (SELECT id FROM testcase WHERE project_id=?)";
    let where = " WHERE 1=1" + ofProject;
    const args: unknown[] = [projectId];
    if (q.status) {
      where += " AND status=?";
      args.push(q.status);
    }
    const total = (this.db.prepare("SELECT COUNT(*) AS n FROM heal_proposal" + where).get(...args) as { n: number }).n;
    const page = Math.max(q.page, 1);
    const rows = this.db.prepare(
      "SELECT * FROM heal_proposal" + where + " ORDER BY rowid DESC LIMIT ? OFFSET ?",
    ).all(...args, q.pageSize, (page - 1) * q.pageSize);
    return { items: rows as unknown[], total, page, page_size: q.pageSize };
  }

  // ---- review_item (AI 判定人工复核) ----

  pageReviews(projectId: string, q: { page: number; pageSize: number; status?: string }): {
    items: unknown[]; total: number; page: number; page_size: number;
  } {
    const ofProject = " AND case_id IN (SELECT id FROM testcase WHERE project_id=?)";
    let where = " WHERE 1=1" + ofProject;
    const args: unknown[] = [projectId];
    if (q.status) {
      where += " AND status=?";
      args.push(q.status);
    }
    const total = (this.db.prepare("SELECT COUNT(*) AS n FROM review_item" + where).get(...args) as { n: number }).n;
    const page = Math.max(q.page, 1);
    const rows = this.db.prepare(
      "SELECT * FROM review_item" + where + " ORDER BY rowid DESC LIMIT ? OFFSET ?",
    ).all(...args, q.pageSize, (page - 1) * q.pageSize);
    return { items: rows as unknown[], total, page, page_size: q.pageSize };
  }

  // ---- attribution (失败归因) ----

  pageAttributions(projectId: string, q: { page: number; pageSize: number; pending?: boolean }): {
    items: unknown[]; total: number; page: number; page_size: number;
  } {
    if (!this.hasTable("attribution")) return { items: [], total: 0, page: q.page, page_size: q.pageSize };
    let where = " WHERE project_id=?";
    const args: unknown[] = [projectId];
    if (q.pending) {
      where += " AND human_type IS NULL";
    }
    const total = (this.db.prepare("SELECT COUNT(*) AS n FROM attribution" + where).get(...args) as { n: number }).n;
    const page = Math.max(q.page, 1);
    const rows = this.db.prepare(
      "SELECT * FROM attribution" + where + " ORDER BY updated_at DESC, rowid DESC LIMIT ? OFFSET ?",
    ).all(...args, q.pageSize, (page - 1) * q.pageSize);
    return { items: rows as unknown[], total, page, page_size: q.pageSize };
  }

  // ---- run (执行记录) ----

  listRuns(projectId: string, limit = 100, framework?: string): unknown[] {
    const rows = this.db.prepare(
      "SELECT * FROM run WHERE project_id=? ORDER BY started_at DESC",
    ).all(projectId) as { id: string; env: string; mode: string; started_at: string; result: string }[];
    const out: unknown[] = [];
    for (const r of rows) {
      const result = JSON.parse(r.result || "{}");
      const fw = result.framework || "pytest";
      if (framework && fw !== framework) continue;
      out.push({
        id: r.id, env: r.env, mode: r.mode, started_at: r.started_at, framework: fw,
        total: result.total ?? 0, passed: result.passed ?? 0,
        failed: (result.failed ?? 0) + (result.error ?? 0), skipped: result.skipped ?? 0,
        pass_rate: result.pass_rate ?? 0, acceptance: result.acceptance ?? {},
        html_report: result.html_report, junit: result.junit,
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  // ---- script (脚本登记) ----

  scriptMap(framework: string): Record<string, string> {
    const rows = this.db.prepare(
      "SELECT case_id, path FROM script WHERE framework=?",
    ).all(framework) as { case_id: string; path: string }[];
    return Object.fromEntries(rows.map((r) => [r.case_id, r.path]));
  }

  listScripts(): { case_id: string; path: string; framework: string }[] {
    return this.db.prepare("SELECT case_id, path, framework FROM script").all() as any[];
  }

  // ---- role_account ----

  listRoles(projectId: string): { role_name: string; inherited_from?: string }[] {
    // 子项目包含继承自大项目的角色
    const project = this.rawProject(projectId);
    if (!project) return [];
    const own = this.db.prepare(
      "SELECT DISTINCT role_name FROM role_account WHERE project_id=? ORDER BY role_name",
    ).all(projectId) as { role_name: string }[];
    const ownSet = new Set(own.map((r) => r.role_name));
    const roles: { role_name: string; inherited_from?: string }[] = own.map((r) => ({ role_name: r.role_name }));
    if (project.parent_id) {
      const parent = this.db.prepare(
        "SELECT DISTINCT role_name FROM role_account WHERE project_id=? ORDER BY role_name",
      ).all(project.parent_id) as { role_name: string }[];
      for (const r of parent) {
        if (!ownSet.has(r.role_name)) {
          roles.push({ role_name: r.role_name, inherited_from: project.parent_id });
        }
      }
    }
    return roles;
  }

  // ---- ops: token_usage / usage_report / check_budget ----

  tokenUsage(projectId: string): { tokens: number } {
    if (!this.hasTable("agent_session")) return { tokens: 0 };
    const r = this.db.prepare(
      "SELECT COALESCE(SUM(token_usage), 0) AS tokens FROM agent_session WHERE project_id=?",
    ).get(projectId) as { tokens: number };
    return { tokens: r.tokens };
  }

  // ---- ops: settings ----

  getSettings(projectId: string): Record<string, unknown> {
    if (!this.hasTable("project_setting")) return {};
    const project = this.rawProject(projectId);
    if (!project) return {};
    const parentSettings: Record<string, unknown> = {};
    if (project.parent_id) {
      const rows = this.db.prepare("SELECT key, value FROM project_setting WHERE project_id=?").all(project.parent_id) as { key: string; value: string }[];
      for (const r of rows) parentSettings[r.key] = this.parseSettingValue(r.key, r.value);
    }
    const own = this.db.prepare("SELECT key, value FROM project_setting WHERE project_id=?").all(projectId) as { key: string; value: string }[];
    for (const r of own) parentSettings[r.key] = this.parseSettingValue(r.key, r.value);
    return parentSettings;
  }

  getSettingsDetail(projectId: string): {
    effective: Record<string, unknown>;
    own: Record<string, unknown>;
    inherited: Record<string, unknown>;
    parent_id: string;
    parent_name: string;
  } {
    if (!this.hasTable("project_setting")) return { effective: {}, own: {}, inherited: {}, parent_id: "", parent_name: "" };
    const project = this.rawProject(projectId);
    if (!project) return { effective: {}, own: {}, inherited: {}, parent_id: "", parent_name: "" };
    const own: Record<string, unknown> = {};
    for (const r of this.db.prepare("SELECT key, value FROM project_setting WHERE project_id=?").all(projectId) as { key: string; value: string }[]) {
      own[r.key] = this.parseSettingValue(r.key, r.value);
    }
    const parent = project.parent_id ? this.rawProject(project.parent_id) : undefined;
    const inherited: Record<string, unknown> = {};
    if (parent) {
      for (const r of this.db.prepare("SELECT key, value FROM project_setting WHERE project_id=?").all(parent.id) as { key: string; value: string }[]) {
        if (!(r.key in own)) inherited[r.key] = this.parseSettingValue(r.key, r.value);
      }
    }
    return {
      effective: { ...inherited, ...own },
      own,
      inherited,
      parent_id: parent?.id ?? "",
      parent_name: parent?.name ?? "",
    };
  }

  private static INT_SETTINGS = new Set(["monthly_token_budget", "per_task_token_limit"]);
  private static FLOAT_SETTINGS = new Set(["price_per_mtok", "stability_threshold"]);

  private parseSettingValue(key: string, value: string): unknown {
    if (DirectStore.INT_SETTINGS.has(key)) return parseInt(value, 10);
    if (DirectStore.FLOAT_SETTINGS.has(key)) return parseFloat(value);
    return value;
  }

  // ---- ops: stability ----

  stability(projectId: string, window = 10): unknown {
    const rows = this.db.prepare(
      `SELECT r.started_at, r.result, rr.case_id, rr.status FROM run r JOIN run_result rr ON rr.run_id = r.id
       WHERE r.project_id=? ORDER BY r.started_at`,
    ).all(projectId) as { started_at: string; result: string; case_id: string; status: string }[];
    const hist = new Map<string, { status: string; framework: string }[]>();
    for (const row of rows) {
      const fw = JSON.parse(row.result || "{}").framework || "pytest";
      let arr = hist.get(row.case_id);
      if (!arr) { arr = []; hist.set(row.case_id, arr); }
      arr.push({ status: row.status, framework: fw });
    }
    const cases: unknown[] = [];
    const flaky: string[] = [];
    for (const [caseId, h] of hist) {
      const recent = h.filter((x) => x.status !== "skipped").slice(-window);
      if (!recent.length) continue;
      const passed = recent.filter((x) => x.status === "passed").length;
      let flips = 0;
      for (let i = 1; i < recent.length; i++) {
        if ((recent[i].status === "passed") !== (recent[i - 1].status === "passed")) flips++;
      }
      const isFlaky = flips >= 2;
      cases.push({
        case_id: caseId,
        framework: h[h.length - 1].framework,
        runs: recent.length,
        pass_rate: Math.round((passed / recent.length) * 10000) / 10000,
        flaky: isFlaky,
      });
      if (isFlaky) flaky.push(caseId);
    }
    cases.sort((a: any, b: any) => a.pass_rate - b.pass_rate);
    return { window, cases, flaky };
  }

  // ---- ops: metrics ----

  metrics(projectId: string): unknown {
    if (!this.hasTable("event_log")) {
      return {
        first_pass_rate: null, first_pass: { passed: 0, measured: 0 },
        attribution_accuracy: null, attribution: { correct: 0, confirmed: 0 },
        interventions_per_case: null, interventions: { total: 0, cases: 0, by_kind: {} },
        ui_gate: this.uiGate(projectId),
      };
    }

    // 脚本登记时间
    const registered = new Map<string, string>();
    const regEvents = this.db.prepare(
      "SELECT case_id, ts FROM event_log WHERE project_id=? AND kind='script_registered' ORDER BY id",
    ).all(projectId) as { case_id: string; ts: string }[];
    for (const e of regEvents) {
      if (!registered.has(e.case_id)) registered.set(e.case_id, e.ts);
    }

    // 用例执行历史
    const histRows = this.db.prepare(
      `SELECT r.started_at, rr.case_id, rr.status FROM run r JOIN run_result rr ON rr.run_id = r.id
       WHERE r.project_id=? ORDER BY r.started_at`,
    ).all(projectId) as { started_at: string; case_id: string; status: string }[];
    const hist = new Map<string, { at: string; status: string }[]>();
    for (const row of histRows) {
      let arr = hist.get(row.case_id);
      if (!arr) { arr = []; hist.set(row.case_id, arr); }
      arr.push({ at: row.started_at, status: row.status });
    }

    // 一次生成通过率
    let firstPass = 0, measured = 0;
    for (const [caseId, ts] of registered) {
      const after = (hist.get(caseId) ?? []).filter((h) => h.at >= ts && h.status !== "skipped");
      if (after.length) {
        measured++;
        if (after[0].status === "passed") firstPass++;
      }
    }

    // 归因准确率
    let correct = 0, confirmed = 0;
    if (this.hasTable("attribution")) {
      const attrRows = this.db.prepare(
        "SELECT auto_type, human_type FROM attribution WHERE project_id=? AND human_type IS NOT NULL AND auto_type IS NOT NULL",
      ).all(projectId) as { auto_type: string; human_type: string }[];
      confirmed = attrRows.length;
      correct = attrRows.filter((r) => r.auto_type === r.human_type).length;
    }

    // 人工介入
    const INTERVENTIONS = new Set(["fix_applied", "proposal_resolved", "review_resolved", "case_edited", "attribution_confirmed"]);
    const interventionEvents = this.db.prepare(
      "SELECT kind, case_id, actor, data FROM event_log WHERE project_id=? AND kind IN ('fix_applied','proposal_resolved','review_resolved','case_edited','attribution_confirmed')",
    ).all(projectId) as { kind: string; case_id: string; actor: string; data: string }[];
    const filtered = interventionEvents.filter((e) => e.kind !== "case_edited" || e.actor === "human");
    const byKind: Record<string, number> = {};
    const perCase = new Set<string>();
    for (const e of filtered) {
      byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
      if (e.case_id) perCase.add(e.case_id);
    }
    const casesTotal = new Set([...registered.keys(), ...perCase]).size;

    return {
      first_pass_rate: measured ? Math.round((firstPass / measured) * 10000) / 10000 : null,
      first_pass: { passed: firstPass, measured },
      attribution_accuracy: confirmed ? Math.round((correct / confirmed) * 10000) / 10000 : null,
      attribution: { correct, confirmed },
      interventions_per_case: casesTotal ? Math.round((filtered.length / casesTotal) * 100) / 100 : null,
      interventions: {
        total: filtered.length,
        cases: casesTotal,
        by_kind: Object.fromEntries(Object.entries(byKind).sort()),
      },
      ui_gate: this.uiGate(projectId),
    };
  }

  private uiGate(projectId: string, last = 5, minRuns = 3): unknown {
    const settings = this.getSettings(projectId);
    const threshold = (settings.stability_threshold as number) ?? 0.95;
    const runs = this.db.prepare(
      "SELECT id, result FROM run WHERE project_id=? ORDER BY started_at DESC",
    ).all(projectId) as { id: string; result: string }[];
    const uiRuns = runs.filter((r) => JSON.parse(r.result || "{}").framework === "playwright").slice(0, last);
    const rates: number[] = [];
    for (const r of uiRuns) {
      const results = this.db.prepare(
        "SELECT status, failure_type FROM run_result WHERE run_id=?",
      ).all(r.id) as { status: string; failure_type: string }[];
      const counted = results.filter((x) => x.status !== "skipped" && x.failure_type !== "product_bug");
      if (counted.length) {
        rates.push(counted.filter((x) => x.status === "passed").length / counted.length);
      }
    }
    const stabilityResult = this.stability(projectId) as any;
    const flakyUi = (stabilityResult.cases as any[]).filter((c: any) => c.flaky && c.framework === "playwright");
    const avg = rates.length ? Math.round((rates.reduce((a, b) => a + b, 0) / rates.length) * 10000) / 10000 : null;
    const passed = rates.length >= minRuns && avg !== null && avg >= threshold && !flakyUi.length;
    const reasons: string[] = [];
    if (rates.length < minRuns) reasons.push(`UI 回归次数不足：${rates.length}/${minRuns}`);
    if (avg !== null && avg < threshold) reasons.push(`平均通过率 ${(avg * 100).toFixed(1)}% 低于 ${(threshold * 100).toFixed(0)}%`);
    if (flakyUi.length) reasons.push(`不稳定用例 ${flakyUi.length} 条`);
    return {
      passed, runs: rates.length, avg_pass_rate: avg, threshold,
      flaky_cases: flakyUi.map((c: any) => c.case_id), reasons,
    };
  }

  // ---- ops: usage_report & check_budget ----

  usageReport(projectId: string, days = 30): unknown {
    if (!this.hasTable("event_log")) {
      return { days, total_tokens: 0, agent_tasks: 0, by_purpose: {}, by_day: {}, estimated_cost: null, currency: "", all_time_tokens: 0 };
    }
    const project = this.rawProject(projectId);
    const isGroup = project?.kind === "group";
    const scope = isGroup ? [projectId, ...this.childIds(projectId)] : [projectId];
    const since = new Date(Date.now() - days * 86400_000).toISOString();
    const placeholders = scope.map(() => "?").join(",");
    const events = this.db.prepare(
      `SELECT kind, ts, project_id, data FROM event_log WHERE project_id IN (${placeholders}) AND kind IN ('tokens','agent_session') AND ts>=? ORDER BY id`,
    ).all(...scope, since) as { kind: string; ts: string; project_id: string; data: string }[];
    const byPurpose: Record<string, number> = {};
    const byDay: Record<string, number> = {};
    const byProject: Record<string, number> = {};
    let tasks = 0;
    for (const e of events) {
      if (e.kind === "agent_session") { tasks++; continue; }
      const d = JSON.parse(e.data || "{}");
      const t = parseInt(d.tokens ?? "0", 10);
      const purpose = d.purpose ?? "unknown";
      byPurpose[purpose] = (byPurpose[purpose] ?? 0) + t;
      const day = e.ts.slice(0, 10);
      byDay[day] = (byDay[day] ?? 0) + t;
      byProject[e.project_id] = (byProject[e.project_id] ?? 0) + t;
    }
    const total = Object.values(byPurpose).reduce((a, b) => a + b, 0);
    const settings = this.getSettings(projectId);
    const price = settings.price_per_mtok as number | undefined;
    // all_time_tokens
    let allTime = 0;
    if (this.hasTable("agent_session")) {
      const r = this.db.prepare(
        `SELECT COALESCE(SUM(token_usage), 0) AS t FROM agent_session WHERE project_id IN (${placeholders})`,
      ).get(...scope) as { t: number };
      allTime = r.t;
    }
    return {
      days, total_tokens: total, agent_tasks: tasks,
      by_purpose: Object.fromEntries(Object.entries(byPurpose).sort((a, b) => b[1] - a[1])),
      by_day: Object.fromEntries(Object.entries(byDay).sort()),
      estimated_cost: price != null ? Math.round((total / 1_000_000) * price * 10000) / 10000 : null,
      currency: (settings.currency as string) ?? "",
      all_time_tokens: allTime,
      ...(scope.length > 1 ? { by_project: byProject } : {}),
    };
  }

  checkBudget(projectId: string): unknown {
    const settings = this.getSettings(projectId);
    const budget = (settings.monthly_token_budget as number) || 0;
    const project = this.rawProject(projectId);
    // 预算范围
    let scope: string[];
    if (project?.kind === "group") {
      scope = [projectId, ...this.childIds(projectId)];
    } else if (project?.parent_id) {
      const ownSettings = this.ownSettings(projectId);
      const parentSettings = this.ownSettings(project.parent_id);
      if (!("monthly_token_budget" in ownSettings) && "monthly_token_budget" in parentSettings) {
        scope = [project.parent_id, ...this.childIds(project.parent_id)];
      } else {
        scope = [projectId];
      }
    } else {
      scope = [projectId];
    }
    const monthStart = new Date();
    monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
    let used = 0;
    if (this.hasTable("event_log")) {
      const placeholders = scope.map(() => "?").join(",");
      const rows = this.db.prepare(
        `SELECT data FROM event_log WHERE project_id IN (${placeholders}) AND kind='tokens' AND ts>=?`,
      ).all(...scope, monthStart.toISOString()) as { data: string }[];
      for (const r of rows) {
        used += parseInt(JSON.parse(r.data || "{}").tokens ?? "0", 10);
      }
    }
    const remaining = budget ? Math.max(budget - used, 0) : null;
    let perTask = (settings.per_task_token_limit as number) || null;
    if (remaining !== null && perTask) perTask = Math.min(perTask, remaining);
    return {
      month_used: used, monthly_budget: budget || null, remaining,
      allowed: !budget || used < budget,
      per_task_limit: perTask ?? (remaining ?? null),
      shared: scope.length > 1,
    };
  }

  // ---- ops: case_history ----

  caseHistory(caseId: string): unknown[] {
    if (!this.hasTable("event_log")) return [];
    const c = this.db.prepare("SELECT project_id FROM testcase WHERE id=?").get(caseId) as { project_id: string } | undefined;
    if (!c) return [];
    const rows = this.db.prepare(
      "SELECT * FROM event_log WHERE project_id=? AND kind IN ('case_edited','fix_applied') AND case_id=? ORDER BY id DESC LIMIT 100",
    ).all(c.project_id, caseId) as any[];
    return rows.map((r) => ({ ...r, data: JSON.parse(r.data || "{}") })).reverse();
  }

  // ---- ops: performance_history ----

  performanceHistory(projectId: string): unknown[] {
    if (!this.hasTable("event_log")) return [];
    const rows = this.db.prepare(
      "SELECT data FROM event_log WHERE project_id=? AND kind='performance' ORDER BY id DESC LIMIT 50",
    ).all(projectId) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data || "{}"));
  }

  // ---- 辅助 ----

  private childIds(groupId: string): string[] {
    return (this.db.prepare("SELECT id FROM project WHERE parent_id=? ORDER BY name").all(groupId) as { id: string }[]).map((r) => r.id);
  }

  private ownSettings(projectId: string): Record<string, unknown> {
    if (!this.hasTable("project_setting")) return {};
    const rows = this.db.prepare("SELECT key, value FROM project_setting WHERE project_id=?").all(projectId) as { key: string; value: string }[];
    const out: Record<string, unknown> = {};
    for (const r of rows) out[r.key] = this.parseSettingValue(r.key, r.value);
    return out;
  }

  private groupCount<T>(items: T[], key: keyof T): Record<string, number> {
    const out: Record<string, number> = {};
    for (const item of items) {
      const v = String(item[key] ?? "");
      out[v] = (out[v] ?? 0) + 1;
    }
    return out;
  }
}
