"""三期：自愈与工程化（架构文档第 13、16、17 节）。

- 事件日志：token 用量、脚本登记、人工介入，均带时间戳，供统计与指标使用
- 失败归因：规则 / agent 的判定落库，人工确认后计算归因准确率
- 用量统计与成本上限：按用途、按天统计 token，项目级月度预算与单次任务上限
- 首期验证指标：一次生成通过率、失败归因准确率、人工介入次数；回归稳定性与门禁
- 团队共享：项目元数据与用例导出到 workspace（随 git 共享），可在另一台机器或 CI 导入
"""

from __future__ import annotations

import json
import re
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from . import hierarchy
from .models import Project, RoleAccount, Script, TestCase, TestData
from .store import Store

OPS_SCHEMA = """
CREATE TABLE IF NOT EXISTS event_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, project_id TEXT, kind TEXT NOT NULL,
  case_id TEXT, ref_id TEXT, actor TEXT, data TEXT
);
CREATE INDEX IF NOT EXISTS idx_event_project_kind ON event_log(project_id, kind);
CREATE TABLE IF NOT EXISTS attribution (
  run_id TEXT NOT NULL, case_id TEXT NOT NULL, project_id TEXT, auto_type TEXT, source TEXT, reason TEXT,
  human_type TEXT, updated_at TEXT, PRIMARY KEY (run_id, case_id)
);
CREATE TABLE IF NOT EXISTS project_setting (
  project_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT, PRIMARY KEY (project_id, key)
);
"""

# 人工介入的事件种类（第 17 节「人工介入次数」）
INTERVENTIONS = {"fix_applied", "proposal_resolved", "review_resolved", "case_edited", "attribution_confirmed"}
FAILURE_TYPES = {"product_bug", "script_error", "environment"}
SETTING_KEYS = {
    "monthly_token_budget": int,  # 项目月度 token 上限，0 / 不设表示不限
    "per_task_token_limit": int,  # 单次 agent 任务上限
    "price_per_mtok": float,  # 每百万 token 价格（用于成本估算，币种自定）
    "currency": str,
    "stability_threshold": float,  # 门禁：UI 回归平均通过率
}
_SECRET_KEY = re.compile(r"(token|password|passwd|secret|api[_-]?key|credential)", re.I)


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def ensure_schema(store: Store) -> Store:
    store.conn.executescript(OPS_SCHEMA)
    return store


# --------------------------------------------------------------------------- 事件日志


def log_event(store: Store, kind: str, project_id: str = "", case_id: str = "", ref_id: str = "",
              actor: str = "system", data: dict[str, Any] | None = None) -> None:
    store.conn.execute(
        "INSERT INTO event_log (ts, project_id, kind, case_id, ref_id, actor, data) VALUES (?,?,?,?,?,?,?)",
        (now(), project_id, kind, case_id, ref_id, actor, json.dumps(data or {}, ensure_ascii=False)),
    )
    store.conn.commit()


def events(store: Store, project_id: str | list[str], kinds: set[str] | None = None,
           since: str | None = None) -> list[dict[str, Any]]:
    ids = [project_id] if isinstance(project_id, str) else project_id
    sql, args = f"SELECT * FROM event_log WHERE project_id IN ({','.join('?' * len(ids))})", list(ids)
    if since:
        sql, args = sql + " AND ts>=?", [*args, since]
    rows = store.conn.execute(sql + " ORDER BY id", args).fetchall()
    out = [{**dict(r), "data": json.loads(r["data"] or "{}")} for r in rows]
    return [e for e in out if not kinds or e["kind"] in kinds]


def project_of_case(store: Store, case_id: str) -> str:
    c = store.get_case(case_id)
    return c.project_id if c else ""


# --------------------------------------------------------------------------- 设置、用量与预算


def set_setting(store: Store, project_id: str, key: str, value: str) -> dict[str, Any]:
    """value 为空字符串时删除本项目的设置（子项目恢复继承大项目的值）。"""
    if key not in SETTING_KEYS:
        raise ValueError(f"未知设置项：{key}（可选：{', '.join(SETTING_KEYS)}）")
    if value == "":
        store.conn.execute("DELETE FROM project_setting WHERE project_id=? AND key=?", (project_id, key))
    else:
        SETTING_KEYS[key](value)  # 校验类型
        store.conn.execute("INSERT OR REPLACE INTO project_setting VALUES (?,?,?)", (project_id, key, value))
    store.conn.commit()
    return get_settings(store, project_id)


def own_settings(store: Store, project_id: str) -> dict[str, Any]:
    rows = store.conn.execute("SELECT key, value FROM project_setting WHERE project_id=?", (project_id,)).fetchall()
    return {r["key"]: SETTING_KEYS[r["key"]](r["value"]) for r in rows if r["key"] in SETTING_KEYS}


def get_settings(store: Store, project_id: str) -> dict[str, Any]:
    """生效的设置：子项目逐项继承大项目，自己设置的优先。"""
    parent = store.parent_of(project_id)
    return {**(own_settings(store, parent.id) if parent else {}), **own_settings(store, project_id)}


def settings_detail(store: Store, project_id: str) -> dict[str, Any]:
    parent = store.parent_of(project_id)
    own = own_settings(store, project_id)
    inherited = {k: v for k, v in (own_settings(store, parent.id) if parent else {}).items() if k not in own}
    return {"effective": {**inherited, **own}, "own": own, "inherited": inherited,
            "parent_id": parent.id if parent else "", "parent_name": parent.name if parent else ""}


def _budget_scope(store: Store, project_id: str) -> list[str]:
    """预算的统计范围：大项目或继承了大项目预算的子项目，按整个大项目累计。"""
    p = store.get_project(project_id)
    if p and hierarchy.is_group(p):
        return hierarchy.scope_ids(store, p.id)
    parent = store.parent_of(project_id)
    if parent and "monthly_token_budget" not in own_settings(store, project_id) \
            and "monthly_token_budget" in own_settings(store, parent.id):
        return hierarchy.scope_ids(store, parent.id)
    return [project_id]


def record_tokens(store: Store, session_id: str, tokens: int) -> None:
    store.add_token_usage(session_id, tokens)
    r = store.conn.execute("SELECT project_id, purpose FROM agent_session WHERE id=?", (session_id,)).fetchone()
    if r:
        log_event(store, "tokens", r["project_id"], ref_id=session_id, data={"tokens": tokens, "purpose": r["purpose"]})


def usage_report(store: Store, project_id: str, days: int = 30) -> dict[str, Any]:
    since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    by_purpose: dict[str, int] = defaultdict(int)
    by_day: dict[str, int] = defaultdict(int)
    by_project: dict[str, int] = defaultdict(int)
    tasks = 0
    p = store.get_project(project_id)
    # 大项目汇总全部子项目的用量
    scope = hierarchy.scope_ids(store, project_id) if p and hierarchy.is_group(p) else [project_id]
    for e in events(store, scope, {"tokens", "agent_session"}, since):
        if e["kind"] == "agent_session":
            tasks += 1
            continue
        t = int(e["data"].get("tokens", 0))
        by_purpose[e["data"].get("purpose", "unknown")] += t
        by_day[e["ts"][:10]] += t
        by_project[e["project_id"]] += t
    total = sum(by_purpose.values())
    settings = get_settings(store, project_id)
    price = settings.get("price_per_mtok")
    return {
        "days": days,
        "total_tokens": total,
        "agent_tasks": tasks,
        "by_purpose": dict(sorted(by_purpose.items(), key=lambda x: -x[1])),
        "by_day": dict(sorted(by_day.items())),
        "estimated_cost": round(total / 1_000_000 * price, 4) if price is not None else None,
        "currency": settings.get("currency", ""),
        "all_time_tokens": sum(store.project_token_usage(pid) for pid in scope),
        **({"by_project": dict(by_project)} if len(scope) > 1 else {}),
    }


def check_budget(store: Store, project_id: str) -> dict[str, Any]:
    """agent 任务开始前调用：超出月度预算则拒绝（日常回归不耗模型，不受影响）。"""
    settings = get_settings(store, project_id)
    month_start = datetime.now(timezone.utc).replace(day=1, hour=0, minute=0, second=0, microsecond=0).isoformat()
    scope = _budget_scope(store, project_id)
    used = sum(int(e["data"].get("tokens", 0)) for e in events(store, scope, {"tokens"}, month_start))
    budget = settings.get("monthly_token_budget") or 0
    remaining = max(budget - used, 0) if budget else None
    per_task = settings.get("per_task_token_limit") or None
    if remaining is not None and per_task:
        per_task = min(per_task, remaining)
    return {
        "month_used": used,
        "monthly_budget": budget or None,
        "remaining": remaining,
        "allowed": not budget or used < budget,
        "per_task_limit": per_task or (remaining if remaining is not None else None),
        "shared": len(scope) > 1,
    }


# --------------------------------------------------------------------------- 失败归因


def set_attribution(store: Store, run_id: str, case_id: str, failure_type: str, source: str = "agent",
                    reason: str = "") -> dict[str, Any]:
    if failure_type not in FAILURE_TYPES:
        raise ValueError(f"failure_type 应为 {sorted(FAILURE_TYPES)}")
    project_id = _run_project(store, run_id)
    store.conn.execute(
        """INSERT INTO attribution (run_id, case_id, project_id, auto_type, source, reason, updated_at)
           VALUES (?,?,?,?,?,?,?)
           ON CONFLICT(run_id, case_id) DO UPDATE SET auto_type=excluded.auto_type, source=excluded.source,
             reason=excluded.reason, updated_at=excluded.updated_at""",
        (run_id, case_id, project_id, failure_type, source, reason, now()),
    )
    store.conn.execute("UPDATE run_result SET failure_type=? WHERE run_id=? AND case_id=?", (failure_type, run_id, case_id))
    store.conn.commit()
    return get_attribution(store, run_id, case_id)


def confirm_attribution(store: Store, run_id: str, case_id: str, failure_type: str) -> dict[str, Any]:
    """人工确认归因：用于计算失败归因准确率，并以人工结论为准。"""
    if failure_type not in FAILURE_TYPES:
        raise ValueError(f"failure_type 应为 {sorted(FAILURE_TYPES)}")
    project_id = _run_project(store, run_id)
    store.conn.execute(
        """INSERT INTO attribution (run_id, case_id, project_id, human_type, updated_at) VALUES (?,?,?,?,?)
           ON CONFLICT(run_id, case_id) DO UPDATE SET human_type=excluded.human_type, updated_at=excluded.updated_at""",
        (run_id, case_id, project_id, failure_type, now()),
    )
    store.conn.execute("UPDATE run_result SET failure_type=? WHERE run_id=? AND case_id=?", (failure_type, run_id, case_id))
    store.conn.commit()
    log_event(store, "attribution_confirmed", project_id, case_id, run_id, actor="human", data={"type": failure_type})
    return get_attribution(store, run_id, case_id)


def get_attribution(store: Store, run_id: str, case_id: str) -> dict[str, Any]:
    r = store.conn.execute("SELECT * FROM attribution WHERE run_id=? AND case_id=?", (run_id, case_id)).fetchone()
    return dict(r) if r else {}


def _attribution_where(pending_only: bool) -> str:
    return " WHERE project_id=?" + (" AND human_type IS NULL" if pending_only else "")


def list_attributions(store: Store, project_id: str, pending_only: bool = False, *,
                      limit: int | None = None, offset: int = 0) -> list[dict[str, Any]]:
    sql = "SELECT * FROM attribution" + _attribution_where(pending_only) + " ORDER BY updated_at DESC, rowid DESC"
    args: list[Any] = [project_id]
    if limit:
        sql, args = sql + " LIMIT ? OFFSET ?", args + [limit, max(offset, 0)]
    return [dict(r) for r in store.conn.execute(sql, args).fetchall()]


def count_attributions(store: Store, project_id: str, pending_only: bool = False) -> int:
    return store.conn.execute("SELECT COUNT(*) FROM attribution" + _attribution_where(pending_only),
                              (project_id,)).fetchone()[0]


def _run_project(store: Store, run_id: str) -> str:
    r = store.conn.execute("SELECT project_id FROM run WHERE id=?", (run_id,)).fetchone()
    if not r:
        raise KeyError(f"执行记录不存在：{run_id}")
    return r["project_id"]


# --------------------------------------------------------------------------- 指标与门禁


def _case_history(store: Store, project_id: str) -> dict[str, list[tuple[str, str, str]]]:
    """case_id → [(started_at, status, framework)]，按时间排序。"""
    rows = store.conn.execute(
        """SELECT r.started_at, r.result, rr.case_id, rr.status FROM run r JOIN run_result rr ON rr.run_id = r.id
           WHERE r.project_id=? ORDER BY r.started_at""",
        (project_id,),
    ).fetchall()
    hist: dict[str, list[tuple[str, str, str]]] = defaultdict(list)
    for row in rows:
        framework = json.loads(row["result"] or "{}").get("framework", "pytest")
        hist[row["case_id"]].append((row["started_at"], row["status"], framework))
    return hist


def stability(store: Store, project_id: str, window: int = 10) -> dict[str, Any]:
    cases = []
    for case_id, h in _case_history(store, project_id).items():
        recent = [s for _, s, _ in h if s != "skipped"][-window:]
        if not recent:
            continue
        passed = sum(1 for s in recent if s == "passed")
        flips = sum(1 for a, b in zip(recent, recent[1:]) if (a == "passed") != (b == "passed"))
        cases.append({
            "case_id": case_id,
            "framework": h[-1][2],
            "runs": len(recent),
            "pass_rate": round(passed / len(recent), 4),
            # 结果来回翻转两次以上视为不稳定（同一脚本时好时坏）
            "flaky": flips >= 2,
        })
    return {"window": window, "cases": sorted(cases, key=lambda c: c["pass_rate"]),
            "flaky": [c["case_id"] for c in cases if c["flaky"]]}


def ui_gate(store: Store, project_id: str, last: int = 5, min_runs: int = 3) -> dict[str, Any]:
    """门禁「UI 回归稳定」：最近若干次 UI 回归平均通过率达标，且没有不稳定用例。
    产品缺陷导致的失败不计入（那是测试发现了问题，不是测试不稳定）。"""
    threshold = get_settings(store, project_id).get("stability_threshold", 0.95)
    runs = store.conn.execute("SELECT id, result FROM run WHERE project_id=? ORDER BY started_at DESC", (project_id,)).fetchall()
    ui_runs = [r for r in runs if json.loads(r["result"] or "{}").get("framework") == "playwright"][:last]
    rates = []
    for r in ui_runs:
        results = store.list_run_results(r["id"])
        counted = [x for x in results if x.status != "skipped" and x.failure_type != "product_bug"]
        if counted:
            rates.append(sum(1 for x in counted if x.status == "passed") / len(counted))
    flaky = [c for c in stability(store, project_id)["cases"] if c["flaky"] and c["framework"] == "playwright"]
    avg = round(sum(rates) / len(rates), 4) if rates else None
    passed = len(rates) >= min_runs and avg is not None and avg >= threshold and not flaky
    reasons = []
    if len(rates) < min_runs:
        reasons.append(f"UI 回归次数不足：{len(rates)}/{min_runs}")
    if avg is not None and avg < threshold:
        reasons.append(f"平均通过率 {avg:.1%} 低于 {threshold:.0%}")
    if flaky:
        reasons.append(f"不稳定用例 {len(flaky)} 条")
    return {"passed": passed, "runs": len(rates), "avg_pass_rate": avg, "threshold": threshold,
            "flaky_cases": [c["case_id"] for c in flaky], "reasons": reasons}


def metrics(store: Store, project_id: str) -> dict[str, Any]:
    """首期验证的三项指标（第 17 节）。"""
    registered: dict[str, str] = {}
    for e in events(store, project_id, {"script_registered"}):
        registered.setdefault(e["case_id"], e["ts"])
    hist = _case_history(store, project_id)
    first_pass, measured = 0, 0
    for case_id, ts in registered.items():
        after = [s for t, s, _ in hist.get(case_id, []) if t >= ts and s != "skipped"]
        if after:
            measured += 1
            first_pass += after[0] == "passed"

    rows = store.conn.execute(
        "SELECT auto_type, human_type FROM attribution WHERE project_id=? AND human_type IS NOT NULL AND auto_type IS NOT NULL",
        (project_id,),
    ).fetchall()
    correct = sum(1 for r in rows if r["auto_type"] == r["human_type"])

    interventions = events(store, project_id, INTERVENTIONS)
    per_case: dict[str, int] = defaultdict(int)
    for e in interventions:
        if e["case_id"]:
            per_case[e["case_id"]] += 1
    cases_total = len(set(registered) | set(per_case))
    return {
        "first_pass_rate": round(first_pass / measured, 4) if measured else None,
        "first_pass": {"passed": first_pass, "measured": measured},
        "attribution_accuracy": round(correct / len(rows), 4) if rows else None,
        "attribution": {"correct": correct, "confirmed": len(rows)},
        "interventions_per_case": round(len(interventions) / cases_total, 2) if cases_total else None,
        "interventions": {"total": len(interventions), "cases": cases_total,
                          "by_kind": dict(sorted(_count(e["kind"] for e in interventions).items()))},
        "ui_gate": ui_gate(store, project_id),
    }


def _count(items) -> dict[str, int]:
    out: dict[str, int] = defaultdict(int)
    for i in items:
        out[i] += 1
    return out


# --------------------------------------------------------------------------- 团队共享


# 这些字段的值是选择器或接口配置，不是凭据（如登录方式里的 password 是密码框的选择器）
_NON_SECRET_SECTIONS = {"login", "data_api", "clock_api"}


def _strip_secrets(obj: Any) -> Any:
    if isinstance(obj, dict):
        return {k: (v if k in _NON_SECRET_SECTIONS else _strip_secrets(v))
                for k, v in obj.items() if k in _NON_SECRET_SECTIONS or not _SECRET_KEY.search(k)}
    if isinstance(obj, list):
        return [_strip_secrets(v) for v in obj]
    return obj


def export_workspace(store: Store, project_id: str) -> dict[str, Any]:
    """导出到 workspace，随 git 共享：.aitest/project.json、cases/*.json、.aitest/scripts.json。不含任何凭据。"""
    p = store.get_project(project_id)
    if p is None:
        raise KeyError(project_id)
    root = Path(p.workspace_path)
    meta_dir = root / ".aitest"
    case_dir = root / "cases"
    meta_dir.mkdir(parents=True, exist_ok=True)
    case_dir.mkdir(parents=True, exist_ok=True)
    cases = store.list_cases(project_id)
    meta = {
        "format": 1,
        "id": p.id,
        "name": p.name,
        # 子项目导出生效的配置（含继承自大项目的），成员导入后可直接使用
        "environments": _strip_secrets(hierarchy.effective_environments(store, p)),
        "roles": sorted({r.role_name for pid in ([p.parent_id] if p.parent_id else []) + [project_id]
                         for r in store.list_role_accounts(pid)}),
        "test_data": [{"key": d.key, "check_script": d.check_script, "seed_script": d.seed_script}
                      for d in store.list_test_data(project_id)],
        "settings": get_settings(store, project_id),
    }
    (meta_dir / "project.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    keep = set()
    for c in cases:
        f = case_dir / f"{c.id}.json"
        f.write_text(json.dumps(c.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8")
        keep.add(f.name)
    for f in case_dir.glob("tc_*.json"):
        if f.name not in keep:
            f.unlink()
    case_ids = {c.id for c in cases}
    scripts = [{"case_id": s.case_id, "path": s.path, "framework": s.framework}
               for s in store.list_scripts() if s.case_id in case_ids]
    (meta_dir / "scripts.json").write_text(json.dumps(scripts, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"workspace": str(root), "cases": len(cases), "scripts": len(scripts), "roles": len(meta["roles"])}


def import_workspace(store: Store, workspace: str | Path, name: str | None = None) -> dict[str, Any]:
    """从 workspace 导入（新成员 clone 后、或 CI 中使用）。幂等：重复导入只做更新。"""
    root = Path(workspace).resolve()
    meta_file = root / ".aitest" / "project.json"
    if not meta_file.exists():
        raise FileNotFoundError(f"不是已导出的 workspace（缺少 {meta_file}）")
    meta = json.loads(meta_file.read_text(encoding="utf-8"))
    project = Project(id=meta["id"], name=name or meta["name"], workspace_path=str(root),
                      environments=meta.get("environments", {}))
    existing = store.get_project(project.id)
    if existing:  # 本地可能补充过环境配置，以本地为准合并；保留所属大项目
        project.parent_id, project.kind = existing.parent_id, existing.kind
        project.environments = (existing.environments if existing.parent_id
                                else {**project.environments, **existing.environments})
    store.add_project(project)
    for role in meta.get("roles", []):
        if role not in {r.role_name for r in store.list_role_accounts(project.id)}:
            store.add_role_account(RoleAccount(project_id=project.id, role_name=role,
                                               credential_ref=f"aitest:{project.id}:role:{role}",
                                               storage_state_path=f"scripts/ui/.auth/{role}.json"))
    for d in meta.get("test_data", []):
        old = store.get_test_data(project.id, d["key"])
        store.add_test_data(TestData(project_id=project.id, key=d["key"], check_script=d.get("check_script", ""),
                                     seed_script=d.get("seed_script", ""), **({"id": old.id} if old else {})))
    for key, value in (meta.get("settings") or {}).items():
        if key in SETTING_KEYS:
            set_setting(store, project.id, key, str(value))
    n_cases = 0
    for f in sorted((root / "cases").glob("tc_*.json")):
        data = json.loads(f.read_text(encoding="utf-8"))
        data["project_id"] = project.id
        store.upsert_case(TestCase.from_dict(data), validate=False)
        n_cases += 1
    scripts_file = root / ".aitest" / "scripts.json"
    n_scripts = 0
    if scripts_file.exists():
        for s in json.loads(scripts_file.read_text(encoding="utf-8")):
            store.upsert_script(Script(case_id=s["case_id"], path=s["path"], framework=s["framework"]))
            n_scripts += 1
    return {"project_id": project.id, "name": project.name, "cases": n_cases, "scripts": n_scripts,
            "roles": len(meta.get("roles", []))}
