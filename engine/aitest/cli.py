"""JSON 命令行：编排层与 MCP Server 通过它调用引擎。

所有命令输出一行 JSON：``{"ok": true, "data": ...}`` 或 ``{"ok": false, "error": "..."}``。
凭据不通过参数传递：run-api-suite 从环境变量 AITEST_AUTH_TOKEN 读取（由客户端从钥匙串注入）。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import asdict
from pathlib import Path
from typing import Any, Callable

from datetime import datetime, timezone

from . import apigen, db, docparser, heal, hierarchy, importer, linter, openapi, ops, reports, router, runner, workspace
from .models import AgentSession, Project, ReviewItem, RoleAccount, Run, RunResult, Script, TestCase, TestData, dumps
from .store import Store

DEFAULT_DB = os.environ.get("AITEST_DB", str(Path.home() / ".aitest" / "aitest.db"))


def _project(store: Store, project_id: str) -> Project:
    p = store.get_project(project_id)
    if p is None:
        raise KeyError(f"项目不存在：{project_id}")
    return p


def _leaf(store: Store, project_id: str) -> Project:
    """用例、脚本、执行相关的命令只能用于（子）项目，大项目只放共享配置。"""
    p = _project(store, project_id)
    if hierarchy.is_group(p):
        raise ValueError(f"「{p.name}」是大项目，只存放共享配置；请在其子项目中操作")
    return p


def _group(store: Store, project_id: str) -> Project:
    p = _project(store, project_id)
    if not hierarchy.is_group(p):
        raise ValueError(f"「{p.name}」不是大项目")
    return p


def _paged(a: argparse.Namespace, fetch: Callable[[int | None, int], list], count: Callable[[], int],
           **extra: Any) -> Any:
    """未指定 --page-size 时返回完整列表（兼容已有调用方）；
    指定时返回 ``{"items", "total", "page", "page_size", ...}``，页码从 1 开始。"""
    if not a.page_size:
        return fetch(None, 0)
    page = max(a.page, 1)
    return {"items": fetch(a.page_size, (page - 1) * a.page_size), "total": count(), "page": page,
            "page_size": a.page_size, **extra}


def cmd_init_project(store: Store, a: argparse.Namespace) -> Any:
    envs = json.loads(a.environments) if a.environments else {}
    if a.kind == hierarchy.GROUP:
        if a.parent:
            raise ValueError("大项目不能再挂到其它大项目下（只支持两层）")
        # 大项目不含用例，没有 workspace
        p = Project(name=a.name, workspace_path="", environments=envs, kind=hierarchy.GROUP)
        return hierarchy.project_view(store, store.add_project(p))
    if not a.workspace:
        raise ValueError("项目需要 --workspace")
    parent = _group(store, a.parent) if a.parent else None
    p = Project(name=a.name, workspace_path=str(Path(a.workspace).resolve()), environments=envs,
                parent_id=parent.id if parent else "")
    workspace.init_workspace(p.workspace_path, p.name)
    return hierarchy.project_view(store, store.add_project(p))


def cmd_list_projects(store: Store, a: argparse.Namespace) -> Any:
    return [hierarchy.project_view(store, p) for p in store.list_projects()]


def cmd_project_overview(store: Store, a: argparse.Namespace) -> Any:
    """大项目概览：各子项目的用例数、最近一次执行与本月 token 用量。"""
    g = _group(store, a.project)
    month_start = datetime.now(timezone.utc).replace(day=1, hour=0, minute=0, second=0, microsecond=0).isoformat()
    children = []
    for cid in store.child_ids(g.id):
        c = store.get_project(cid)
        if c is None:
            continue
        last = store.conn.execute("SELECT * FROM run WHERE project_id=? ORDER BY started_at DESC LIMIT 1", (cid,)).fetchone()
        result = json.loads(last["result"] or "{}") if last else {}
        tokens = sum(int(e["data"].get("tokens", 0)) for e in ops.events(store, cid, {"tokens"}, month_start))
        children.append({
            "id": c.id, "name": c.name, "workspace_path": c.workspace_path,
            "cases": store.count_cases(cid),
            "reviewed": store.count_cases(cid, status="reviewed"),
            "blocked": store.count_cases(cid, lint_status="blocked"),
            "last_run": {"run_id": last["id"], "started_at": last["started_at"], "env": last["env"],
                         "framework": result.get("framework", "pytest"), "total": result.get("total", 0),
                         "passed": result.get("passed", 0), "pass_rate": result.get("pass_rate")} if last else None,
            "month_tokens": tokens,
        })
    return {"project": hierarchy.project_view(store, g), "children": children,
            "budget": ops.check_budget(store, g.id)}


def cmd_parse_requirement(store: Store, a: argparse.Namespace) -> Any:
    _leaf(store, a.project)
    reqs = docparser.parse_requirement(a.file, a.project)
    store.add_requirements(reqs)
    return [{"id": r.id, "section": r.section, "chars": len(r.content)} for r in reqs]


def cmd_list_sections(store: Store, a: argparse.Namespace) -> Any:
    reqs = store.list_requirements(a.project)
    if a.query:
        reqs = [r for r in reqs if a.query in r.section or a.query in r.content]
    return [asdict(r) if a.full else {"id": r.id, "section": r.section, "chars": len(r.content)} for r in reqs]


def cmd_parse_openapi(store: Store, a: argparse.Namespace) -> Any:
    doc = openapi.parse_openapi(a.file)
    return {
        "title": doc.title, "version": doc.version, "servers": doc.servers,
        "operations": [{"method": o.method, "path": o.path, "operation_id": o.operation_id, "summary": o.summary,
                        "secured": o.secured, "params": [asdict(p) for p in o.params],
                        "has_body": o.body_schema is not None, "responses": list(o.responses)}
                       for o in doc.operations],
    }


def cmd_import_excel(store: Store, a: argparse.Namespace) -> Any:
    _leaf(store, a.project)
    column_map = json.loads(a.column_map) if a.column_map else None
    cases = importer.import_excel(a.file, a.project, column_map=column_map, sheet=a.sheet)
    router.route_all(cases)
    report = linter.lint_cases(cases)
    for c in cases:
        store.upsert_case(c, validate=False)  # 导入的原始用例可能不完整，靠 lint 阻断
    store.replace_lint_issues([c.id for c in cases], report.issues)
    return {"imported": len(cases), "lint": {k: v for k, v in report.to_dict().items() if k != "issues"}}


def cmd_lint(store: Store, a: argparse.Namespace) -> Any:
    cases = store.list_cases(a.project)
    if a.case_ids:
        wanted = set(a.case_ids.split(","))
        cases = [c for c in cases if c.id in wanted]
    report = linter.lint_cases(cases, linter.LintConfig(p0_threshold=a.p0_threshold))
    for c in cases:
        store.upsert_case(c, validate=False)
    store.replace_lint_issues([c.id for c in cases], report.issues)
    data = report.to_dict()
    if not a.with_issues:
        data.pop("issues")
    return data


def cmd_list_issues(store: Store, a: argparse.Namespace) -> Any:
    scope = {"project_id": a.project}
    extra = {"levels": store.lint_level_counts(a.case, **scope)} if a.page_size else {}
    return _paged(a, lambda limit, offset: [asdict(i) for i in store.list_lint_issues(
                      a.case, **scope, level=a.level, limit=limit, offset=offset)],
                  lambda: store.count_lint_issues(a.case, **scope, level=a.level), **extra)


def cmd_apply_fix(store: Store, a: argparse.Namespace) -> Any:
    case = store.get_case(a.case)
    if case is None:
        raise KeyError(a.case)
    linter.apply_fix(case, a.field, json.loads(a.value))
    report = linter.lint_cases([case])
    # 集合级规则（分组、P0 占比）只在整批检查时产生，这里保留原有记录
    keep = [i for i in store.list_lint_issues(case.id) if i.rule in ("group_not_subdivided", "p0_ratio")]
    store.upsert_case(case, validate=False)
    store.replace_lint_issues([case.id], [*report.issues, *keep])
    ops.log_event(store, "fix_applied", case.project_id, case.id, actor="human", data={"field": a.field})
    return {"case": case.to_dict(), "issues": [asdict(i) for i in report.issues]}


def cmd_export_excel(store: Store, a: argparse.Namespace) -> Any:
    cases = store.list_cases(a.project)
    return {"path": str(importer.export_excel(cases, a.out)), "cases": len(cases)}


def cmd_create_case(store: Store, a: argparse.Namespace) -> Any:
    p = store.get_project(a.project)
    if p and hierarchy.is_group(p):  # 只拦大项目，不改变原有对项目是否存在的处理
        raise ValueError(f"「{p.name}」是大项目，只存放共享配置；请在其子项目中操作")
    data = json.loads(a.json)
    data["project_id"] = a.project
    case = TestCase.from_dict(data)
    if not data.get("execution_mode"):
        case.execution_mode = router.route(case)
    return store.upsert_case(case).to_dict()


def cmd_update_case(store: Store, a: argparse.Namespace) -> Any:
    case = store.get_case(a.case)
    if case is None:
        raise KeyError(a.case)
    patch = json.loads(a.json)
    merged = {**case.to_dict(), **patch, "id": case.id, "project_id": case.project_id}
    out = store.upsert_case(TestCase.from_dict(merged)).to_dict()
    if a.actor == "human":
        ops.log_event(store, "case_edited", case.project_id, case.id, actor="human", data={"fields": sorted(patch)})
    return out


def cmd_list_cases(store: Store, a: argparse.Namespace) -> Any:
    filters = {"query": a.query, "ids": a.ids, "type": a.type, "priority": a.priority, "execution_mode": a.execution_mode,
               "status": a.status, "lint_status": a.lint_status}
    return _paged(a, lambda limit, offset: [c.to_dict() for c in store.list_cases(
                      a.project, limit=limit, offset=offset, **filters)],
                  lambda: store.count_cases(a.project, **filters))


def cmd_link_requirement(store: Store, a: argparse.Namespace) -> Any:
    return store.link_requirement(a.case, a.requirement).to_dict()


def cmd_route(store: Store, a: argparse.Namespace) -> Any:
    cases = store.list_cases(a.project)
    counts = router.route_all(cases, overwrite=a.overwrite)
    for c in cases:
        store.upsert_case(c, validate=False)
    return counts


def cmd_generate_api_cases(store: Store, a: argparse.Namespace) -> Any:
    _leaf(store, a.project)
    doc = openapi.parse_openapi(a.openapi)
    cases = apigen.generate_suite(doc, a.project)
    if a.operation:
        cases = [c for c in cases if c.api and c.api.operation_id == a.operation]
    for c in cases:
        store.upsert_case(c)
    return {"generated": len(cases), "case_ids": [c.id for c in cases]}


def cmd_write_api_suite(store: Store, a: argparse.Namespace) -> Any:
    p = _leaf(store, a.project)
    cases = store.list_cases(a.project, execution_mode="api")
    issues = store.list_lint_issues()
    eligible = [c for c in cases if c.is_api_executable and c.status != "deprecated" and linter.can_generate_script(c, issues)]
    if a.reviewed_only:
        eligible = [c for c in eligible if c.status == "reviewed"]
    out = Path(p.workspace_path) / "scripts" / "api"
    files = apigen.write_pytest_suite(eligible, out, a.suite)
    files["version"] = workspace.commit(p.workspace_path, f"生成接口脚本 {a.suite}（{len(eligible)} 条）")
    files["skipped"] = len(cases) - len(eligible)
    rel = str(Path(files["test"]).relative_to(Path(p.workspace_path)))
    for c in eligible:
        is_new = not store.list_scripts(c.id)
        store.upsert_script(Script(case_id=c.id, path=rel, framework="pytest", version=files["version"] or ""))
        if is_new:
            ops.log_event(store, "script_registered", p.id, c.id, data={"framework": "pytest"})
    return files


def cmd_run_api_suite(store: Store, a: argparse.Namespace) -> Any:
    p = _leaf(store, a.project)
    env_cfg = hierarchy.effective_environments(store, p).get(a.env)
    if env_cfg is None:
        raise KeyError(f"项目未配置环境：{a.env}")
    env = runner.EnvConfig(
        base_url=env_cfg["base_url"],
        auth_header=os.environ.get("AITEST_AUTH_HEADER") or env_cfg.get("auth_header", "Authorization"),
        auth_token=os.environ.get("AITEST_AUTH_TOKEN", ""),
        timeout=float(env_cfg.get("timeout", 30)),
        api_login=env_cfg.get("api_login") or None,
    )
    suite_dir = Path(p.workspace_path) / "scripts" / "api"
    # 入库校验需要的数据库连接（密码来自 AITEST_DB_PASSWORDS，只传给脚本进程）
    db_env = db.runtime_env(db.configs_for_env(env_cfg))
    run, results = runner.run_pytest(suite_dir, env, project_id=p.id, env_name=a.env,
                                     report_dir=Path(p.workspace_path) / "reports", extra_env=db_env)
    store.save_run(run, results)
    return {"run_id": run.id, **run.result}


def cmd_summarize_failures(store: Store, a: argparse.Namespace) -> Any:
    results = [r for r in store.list_run_results(a.run) if r.status in ("failed", "error")]
    return [{"case_id": r.case_id, "failure_type": r.failure_type, "message": r.message[:1500]} for r in results]


def cmd_agent_session(store: Store, a: argparse.Namespace) -> Any:
    s = AgentSession(codex_thread_id=a.thread, purpose=a.purpose, project_id=a.project)
    store.add_agent_session(s)
    ops.log_event(store, "agent_session", a.project, ref_id=s.id, actor="agent", data={"purpose": a.purpose})
    return asdict(s)


def cmd_add_tokens(store: Store, a: argparse.Namespace) -> Any:
    ops.record_tokens(store, a.session, a.tokens)
    return {"session": a.session, "added": a.tokens}


def cmd_token_usage(store: Store, a: argparse.Namespace) -> Any:
    return {"project": a.project, "tokens": store.project_token_usage(a.project)}


def cmd_get_project(store: Store, a: argparse.Namespace) -> Any:
    return hierarchy.project_view(store, _project(store, a.project))


def cmd_get_case(store: Store, a: argparse.Namespace) -> Any:
    case = store.get_case(a.case)
    if case is None:
        raise KeyError(f"用例不存在：{a.case}")
    return case.to_dict()


def cmd_set_environment(store: Store, a: argparse.Namespace) -> Any:
    p = _project(store, a.project)
    cfg = json.loads(a.json)
    if not isinstance(cfg, dict) or not str(cfg.get("base_url", "")).startswith(("http://", "https://")):
        raise ValueError("环境配置需要以 http(s):// 开头的 base_url")
    p.environments[a.env] = cfg
    return asdict(store.add_project(p))


def cmd_delete_environment(store: Store, a: argparse.Namespace) -> Any:
    p = _project(store, a.project)
    if a.env not in p.environments:
        raise KeyError(f"项目未配置环境：{a.env}")
    del p.environments[a.env]
    return asdict(store.add_project(p))


def cmd_update_project(store: Store, a: argparse.Namespace) -> Any:
    p = _project(store, a.project)
    if a.name is not None:
        if not a.name.strip():
            raise ValueError("项目名不能为空")
        p.name = a.name.strip()
    if a.parent is not None:  # 移入大项目；空字符串表示移出成为独立项目
        if hierarchy.is_group(p):
            raise ValueError("大项目不能挂到其它大项目下（只支持两层）")
        p.parent_id = _group(store, a.parent).id if a.parent else ""
    return hierarchy.project_view(store, store.add_project(p))


def cmd_delete_project(store: Store, a: argparse.Namespace) -> Any:
    """从客户端移除项目：删除数据库记录，workspace 目录（用例、脚本、报告与 git 历史）保留，可再导入。"""
    p = _project(store, a.project)
    if hierarchy.is_group(p) and store.child_ids(p.id):
        raise ValueError(f"大项目「{p.name}」下还有 {len(store.child_ids(p.id))} 个子项目，请先移除或移出")
    return {"id": p.id, "workspace_path": p.workspace_path, "deleted": store.delete_project(p.id)}


def cmd_add_role(store: Store, a: argparse.Namespace) -> Any:
    _project(store, a.project)
    existing = {r.role_name: r for r in store.list_role_accounts(a.project)}
    role = existing.get(a.role) or RoleAccount(project_id=a.project, role_name=a.role, credential_ref="")
    # 账号密码存钥匙串，这里只存引用
    role.credential_ref = a.credential_ref or f"aitest:{a.project}:role:{a.role}"
    role.storage_state_path = f"scripts/ui/.auth/{a.role}.json"
    store.add_role_account(role)
    return asdict(role)


def cmd_list_roles(store: Store, a: argparse.Namespace) -> Any:
    """子项目的角色 = 大项目的角色 + 自己的角色（同名以自己的为准），继承的带 inherited_from。"""
    own = [asdict(r) for r in store.list_role_accounts(a.project)]
    parent = store.parent_of(a.project)
    names = {r["role_name"] for r in own}
    inherited = [{**asdict(r), "inherited_from": parent.id} for r in store.list_role_accounts(parent.id)
                 if r.role_name not in names] if parent else []
    return sorted(own + inherited, key=lambda r: r["role_name"])


def cmd_add_test_data(store: Store, a: argparse.Namespace) -> Any:
    _project(store, a.project)
    d = store.get_test_data(a.project, a.key) or TestData(project_id=a.project, key=a.key)
    d.check_script = a.check_script or d.check_script
    d.seed_script = a.seed_script or d.seed_script
    store.add_test_data(d)
    return asdict(d)


def cmd_list_test_data(store: Store, a: argparse.Namespace) -> Any:
    return [asdict(d) for d in store.list_test_data(a.project)]


def cmd_register_script(store: Store, a: argparse.Namespace) -> Any:
    p = _leaf(store, a.project)
    case = store.get_case(a.case)
    if case is None:
        raise KeyError(a.case)
    issues = store.list_lint_issues(a.case)
    if not linter.can_generate_script(case, issues):
        raise ValueError("用例存在未修复的阻断级问题，不能生成脚本")
    version = workspace.commit(p.workspace_path, f"生成脚本：{case.id} {case.title}") or ""
    is_new = not store.list_scripts(a.case)
    s = store.upsert_script(Script(case_id=a.case, path=a.path, framework=a.framework, version=version))
    if is_new:
        ops.log_event(store, "script_registered", p.id, a.case, data={"framework": a.framework})
    return asdict(s)


def cmd_list_scripts(store: Store, a: argparse.Namespace) -> Any:
    return [asdict(s) for s in store.list_scripts(a.case)]


def cmd_save_run(store: Store, a: argparse.Namespace) -> Any:
    """保存外部执行器（Playwright 等）的结果。results 文件为 RunResult 字段组成的 JSON 数组。"""
    _leaf(store, a.project)
    items = json.loads(Path(a.results_file).read_text(encoding="utf-8"))
    run = Run(project_id=a.project, env=a.env, mode=a.mode, started_at=datetime.now(timezone.utc).isoformat())
    results = [RunResult(run_id=run.id, **{k: v for k, v in r.items() if k in RunResult.__dataclass_fields__ and k != "run_id"})
               for r in items]
    for r in results:
        if r.status in ("failed", "error") and not r.failure_type:
            r.failure_type = runner.classify_failure(r.message)
    run.result = runner.summarize(results)
    run.result["framework"] = a.framework
    if a.html_report:
        run.result["html_report"] = a.html_report  # Playwright HTML 报告目录，界面可直接打开
    store.save_run(run, results)
    reviews = []
    for r in items:
        for v in r.get("reviews", []):
            reviews.append(asdict(store.save_review(ReviewItem(
                case_id=r["case_id"], run_id=run.id, kind=v.get("kind", "visual"), description=v.get("description", ""),
                evidence_paths=v.get("evidence_paths", []), ai_verdict=v.get("ai_verdict", "")))))
    return {"run_id": run.id, **run.result, "reviews": len(reviews)}


def cmd_list_run_results(store: Store, a: argparse.Namespace) -> Any:
    return _paged(a, lambda limit, offset: [asdict(r) for r in store.list_run_results(a.run, limit=limit, offset=offset)],
                  lambda: store.count_run_results(a.run))


def cmd_propose_fix(store: Store, a: argparse.Namespace) -> Any:
    p = _leaf(store, a.project)
    proposed = Path(a.content_file).read_text(encoding="utf-8")
    return asdict(heal.propose(store, p.workspace_path, a.case, a.script, proposed, reason=a.reason or "",
                               failure_type=a.failure_type, run_id=a.run or ""))


def cmd_list_proposals(store: Store, a: argparse.Namespace) -> Any:
    def fetch(limit: int | None, offset: int) -> list:
        out = []
        for prop in store.list_proposals(a.status, project_id=a.project, limit=limit, offset=offset):
            d = asdict(prop)
            if not a.full:
                d.pop("original"), d.pop("proposed")
            out.append(d)
        return out
    return _paged(a, fetch, lambda: store.count_proposals(a.status, project_id=a.project))


def cmd_resolve_proposal(store: Store, a: argparse.Namespace) -> Any:
    p = _project(store, a.project)
    d = asdict(heal.resolve(store, p.workspace_path, a.id, a.accept))
    d.pop("original"), d.pop("proposed")
    ops.log_event(store, "proposal_resolved", p.id, d["case_id"], a.id, actor="human", data={"status": d["status"]})
    return d


def cmd_add_review(store: Store, a: argparse.Namespace) -> Any:
    item = ReviewItem(case_id=a.case, kind=a.kind, description=a.description,
                      evidence_paths=json.loads(a.evidence) if a.evidence else [], ai_verdict=a.ai_verdict or "",
                      run_id=a.run or "")
    return asdict(store.save_review(item))


def cmd_list_reviews(store: Store, a: argparse.Namespace) -> Any:
    return _paged(a, lambda limit, offset: [asdict(r) for r in store.list_reviews(
                      a.status, project_id=a.project, limit=limit, offset=offset)],
                  lambda: store.count_reviews(a.status, project_id=a.project))


def cmd_resolve_review(store: Store, a: argparse.Namespace) -> Any:
    items = [r for r in store.list_reviews() if r.id == a.id]
    if not items:
        raise KeyError(a.id)
    item = items[0]
    item.status = "confirmed_pass" if a.passed else "confirmed_fail"
    ops.log_event(store, "review_resolved", ops.project_of_case(store, item.case_id), item.case_id, item.id,
                  actor="human", data={"status": item.status})
    return asdict(store.save_review(item))


# ---- 三期：自愈与工程化 ----


def cmd_set_setting(store: Store, a: argparse.Namespace) -> Any:
    _project(store, a.project)
    return ops.set_setting(store, a.project, a.key, a.value)


def cmd_get_settings(store: Store, a: argparse.Namespace) -> Any:
    return ops.settings_detail(store, a.project) if a.detail else ops.get_settings(store, a.project)


def cmd_usage_report(store: Store, a: argparse.Namespace) -> Any:
    return ops.usage_report(store, a.project, a.days)


def cmd_check_budget(store: Store, a: argparse.Namespace) -> Any:
    return ops.check_budget(store, a.project)


def cmd_set_attribution(store: Store, a: argparse.Namespace) -> Any:
    return ops.set_attribution(store, a.run, a.case, a.type, a.source, a.reason or "")


def cmd_confirm_attribution(store: Store, a: argparse.Namespace) -> Any:
    return ops.confirm_attribution(store, a.run, a.case, a.type)


def cmd_list_attributions(store: Store, a: argparse.Namespace) -> Any:
    return _paged(a, lambda limit, offset: ops.list_attributions(store, a.project, a.pending, limit=limit, offset=offset),
                  lambda: ops.count_attributions(store, a.project, a.pending))


def cmd_metrics(store: Store, a: argparse.Namespace) -> Any:
    return ops.metrics(store, a.project)


def cmd_stability(store: Store, a: argparse.Namespace) -> Any:
    return ops.stability(store, a.project, a.window)


def cmd_export_workspace(store: Store, a: argparse.Namespace) -> Any:
    p = _leaf(store, a.project)
    out = ops.export_workspace(store, a.project)
    out["version"] = workspace.commit(p.workspace_path, "导出项目元数据与用例（团队共享）") if a.commit else None
    return out


def cmd_import_workspace(store: Store, a: argparse.Namespace) -> Any:
    return ops.import_workspace(store, a.workspace, a.name)


class CliArgumentError(ValueError):
    pass


class _Parser(argparse.ArgumentParser):
    """参数错误也按 JSON 协议返回，而不是打印用法后退出。"""

    def error(self, message: str):  # type: ignore[override]
        raise CliArgumentError(f"{self.prog}: {message}")


# ---- 测试报告 ----


def cmd_list_runs(store: Store, a: argparse.Namespace) -> Any:
    return reports.list_runs(store, a.project, a.limit, a.framework)


def cmd_run_detail(store: Store, a: argparse.Namespace) -> Any:
    return reports.run_detail(store, a.run)


def cmd_export_report(store: Store, a: argparse.Namespace) -> Any:
    return reports.export_report(store, a.run, a.format, a.out)


# ---- 被测系统数据库 ----


def _db_configs(store: Store, a: argparse.Namespace) -> dict[str, db.DbConfig]:
    p = _project(store, a.project)
    env_cfg = hierarchy.effective_environments(store, p).get(a.env)  # 子项目含继承自大项目的环境
    if env_cfg is None:
        raise KeyError(f"项目未配置环境：{a.env}")
    return db.configs_for_env(env_cfg)


def _one_db(store: Store, a: argparse.Namespace) -> db.DbConfig:
    configs = _db_configs(store, a)
    name = a.conn or (next(iter(configs)) if len(configs) == 1 else None)
    if not name or name not in configs:
        raise KeyError(f"未配置数据库连接：{a.conn or '（未指定）'}，可用：{', '.join(configs) or '无'}")
    return configs[name]


def cmd_db_list(store: Store, a: argparse.Namespace) -> Any:
    return [c.public() for c in _db_configs(store, a).values()]


def cmd_db_test(store: Store, a: argparse.Namespace) -> Any:
    return db.test_connection(_one_db(store, a))


def cmd_db_query(store: Store, a: argparse.Namespace) -> Any:
    params = json.loads(a.params) if a.params else {}
    return db.query(_one_db(store, a), a.sql, params, a.limit)


def cmd_db_check(store: Store, a: argparse.Namespace) -> Any:
    spec = json.loads(a.spec)
    variables = json.loads(a.vars) if a.vars else {}
    configs = db.configs_from_runtime_env() if a.runtime else _db_configs(store, a)
    return db.check(configs, spec, variables)


def cmd_db_exec(store: Store, a: argparse.Namespace) -> Any:
    params = json.loads(a.params) if a.params else {}
    return db.execute(_one_db(store, a), a.sql, params)


def cmd_db_runtime_env(store: Store, a: argparse.Namespace) -> Any:
    """供客户端 / CI 注入 UI 脚本进程（含密码，只经本地子进程传递，不进模型上下文）。"""
    return db.runtime_env(_db_configs(store, a))


def build_parser() -> argparse.ArgumentParser:
    ap = _Parser(prog="aitest", description="AIProbe 引擎")
    ap.add_argument("--db", default=DEFAULT_DB, help="SQLite 路径（默认 ~/.aitest/aitest.db 或 $AITEST_DB）")
    sub = ap.add_subparsers(dest="command", required=True)

    def add(name: str, fn: Callable, *args: tuple[tuple, dict]) -> None:
        sp = sub.add_parser(name)
        for flags, kw in args:
            sp.add_argument(*flags, **kw)
        sp.set_defaults(fn=fn)

    req = {"required": True}

    def positive(v: str) -> int:
        n = int(v)
        if n < 1:
            raise argparse.ArgumentTypeError("必须是正整数")
        return n

    # 列表命令的分页参数：不传 --page-size 时返回完整列表
    paging = ((("--page",), {"type": positive, "default": 1}),
              (("--page-size",), {"type": positive, "help": "每页条数；指定后返回 {items, total, page, page_size}"}))
    add("init-project", cmd_init_project, (("--name",), req), (("--workspace",), {}), (("--environments",), {}),
        (("--kind",), {"choices": ["project", "group"], "default": "project"}),
        (("--parent",), {"help": "所属大项目 ID"}))
    add("list-projects", cmd_list_projects)
    add("project-overview", cmd_project_overview, (("--project",), req))
    add("parse-requirement", cmd_parse_requirement, (("--project",), req), (("--file",), req))
    add("list-sections", cmd_list_sections, (("--project",), req), (("--query",), {}),
        (("--full",), {"action": "store_true"}))
    add("parse-openapi", cmd_parse_openapi, (("--file",), req))
    add("import-excel", cmd_import_excel, (("--project",), req), (("--file",), req), (("--sheet",), {}),
        (("--column-map",), {}))
    add("lint", cmd_lint, (("--project",), req), (("--case-ids",), {}),
        (("--p0-threshold",), {"type": float, "default": 0.25}), (("--with-issues",), {"action": "store_true"}))
    add("list-issues", cmd_list_issues, (("--case",), {}), (("--project",), {}), (("--level",), {}), *paging)
    add("apply-fix", cmd_apply_fix, (("--case",), req), (("--field",), req), (("--value",), req))
    add("export-excel", cmd_export_excel, (("--project",), req), (("--out",), req))
    add("create-case", cmd_create_case, (("--project",), req), (("--json",), req))
    add("update-case", cmd_update_case, (("--case",), req), (("--json",), req),
        (("--actor",), {"choices": ["agent", "human"], "default": "agent"}))
    # 过滤值可用逗号分隔多个（如 --execution-mode ui,capture）；--query 匹配标题、用例 ID 与模块路径
    add("list-cases", cmd_list_cases, (("--project",), req), (("--query",), {}), (("--ids",), {"help": "逗号分隔的用例 ID"}),
        *[((f"--{k}",), {}) for k in ("type", "priority", "execution-mode", "status", "lint-status")], *paging)
    add("link-requirement", cmd_link_requirement, (("--case",), req), (("--requirement",), req))
    add("route", cmd_route, (("--project",), req), (("--overwrite",), {"action": "store_true"}))
    add("generate-api-cases", cmd_generate_api_cases, (("--project",), req), (("--openapi",), req),
        (("--operation",), {}))
    add("write-api-suite", cmd_write_api_suite, (("--project",), req), (("--suite",), {"default": "api"}),
        (("--reviewed-only",), {"action": "store_true"}))
    add("run-api-suite", cmd_run_api_suite, (("--project",), req), (("--env",), req))
    add("summarize-failures", cmd_summarize_failures, (("--run",), req))
    add("agent-session", cmd_agent_session, (("--project",), req), (("--thread",), req), (("--purpose",), req))
    add("add-tokens", cmd_add_tokens, (("--session",), req), (("--tokens",), {"type": int, "required": True}))
    add("token-usage", cmd_token_usage, (("--project",), req))
    # ---- 二期：UI 测试 ----
    flag = {"action": "store_true"}
    add("get-project", cmd_get_project, (("--project",), req))
    add("get-case", cmd_get_case, (("--case",), req))
    add("set-environment", cmd_set_environment, (("--project",), req), (("--env",), req), (("--json",), req))
    add("delete-environment", cmd_delete_environment, (("--project",), req), (("--env",), req))
    add("update-project", cmd_update_project, (("--project",), req), (("--name",), {}),
        (("--parent",), {"help": "移入的大项目 ID；空字符串表示移出"}))
    add("delete-project", cmd_delete_project, (("--project",), req))
    add("add-role", cmd_add_role, (("--project",), req), (("--role",), req), (("--credential-ref",), {}))
    add("list-roles", cmd_list_roles, (("--project",), req))
    add("add-test-data", cmd_add_test_data, (("--project",), req), (("--key",), req), (("--check-script",), {}),
        (("--seed-script",), {}))
    add("list-test-data", cmd_list_test_data, (("--project",), req))
    add("register-script", cmd_register_script, (("--project",), req), (("--case",), req), (("--path",), req),
        (("--framework",), {"default": "playwright"}))
    add("list-scripts", cmd_list_scripts, (("--case",), {}))
    add("save-run", cmd_save_run, (("--project",), req), (("--env",), req), (("--results-file",), req),
        (("--mode",), {"default": "regression"}), (("--framework",), {"default": "playwright"}),
        (("--html-report",), {}))
    add("list-run-results", cmd_list_run_results, (("--run",), req), *paging)
    add("propose-fix", cmd_propose_fix, (("--project",), req), (("--case",), req), (("--script",), req),
        (("--content-file",), req), (("--reason",), {}), (("--failure-type",), {"default": "script_error"}),
        (("--run",), {}))
    add("list-proposals", cmd_list_proposals, (("--status",), {}), (("--project",), {}), (("--full",), flag), *paging)
    add("resolve-proposal", cmd_resolve_proposal, (("--project",), req), (("--id",), req), (("--accept",), flag))
    add("add-review", cmd_add_review, (("--case",), req), (("--kind",), {"default": "visual"}),
        (("--description",), req), (("--evidence",), {}), (("--ai-verdict",), {}), (("--run",), {}))
    add("list-reviews", cmd_list_reviews, (("--status",), {}), (("--project",), {}), *paging)
    add("resolve-review", cmd_resolve_review, (("--id",), req), (("--passed",), flag))
    # ---- 三期 ----
    failure_types = {"choices": sorted(ops.FAILURE_TYPES), "required": True}
    add("set-setting", cmd_set_setting, (("--project",), req), (("--key",), {"choices": sorted(ops.SETTING_KEYS), "required": True}),
        (("--value",), req))
    add("get-settings", cmd_get_settings, (("--project",), req), (("--detail",), flag))
    add("usage-report", cmd_usage_report, (("--project",), req), (("--days",), {"type": int, "default": 30}))
    add("check-budget", cmd_check_budget, (("--project",), req))
    add("set-attribution", cmd_set_attribution, (("--run",), req), (("--case",), req), (("--type",), failure_types),
        (("--source",), {"choices": ["rule", "agent"], "default": "agent"}), (("--reason",), {}))
    add("confirm-attribution", cmd_confirm_attribution, (("--run",), req), (("--case",), req), (("--type",), failure_types))
    add("list-attributions", cmd_list_attributions, (("--project",), req), (("--pending",), flag), *paging)
    add("metrics", cmd_metrics, (("--project",), req))
    add("stability", cmd_stability, (("--project",), req), (("--window",), {"type": int, "default": 10}))
    add("export-workspace", cmd_export_workspace, (("--project",), req), (("--commit",), flag))
    add("import-workspace", cmd_import_workspace, (("--workspace",), req), (("--name",), {}))
    # ---- 测试报告 ----
    add("list-runs", cmd_list_runs, (("--project",), req), (("--limit",), {"type": int, "default": 50}),
        (("--framework",), {"choices": ["pytest", "playwright"]}))
    add("run-detail", cmd_run_detail, (("--run",), req))
    # ---- 被测系统数据库 ----
    # 连接名用 --conn：--db 是全局参数（引擎自身的 SQLite 路径）
    dbargs = ((("--project",), req), (("--env",), req), (("--conn",), {}))
    add("db-list", cmd_db_list, *dbargs)
    add("db-test", cmd_db_test, *dbargs)
    add("db-query", cmd_db_query, *dbargs, (("--sql",), req), (("--params",), {}), (("--limit",), {"type": int, "default": 200}))
    add("db-check", cmd_db_check, (("--project",), {}), (("--env",), {}), (("--spec",), req), (("--vars",), {}),
        (("--runtime",), {"action": "store_true", "help": "从 AITEST_DATABASES 读取连接（脚本运行时）"}))
    add("db-exec", cmd_db_exec, *dbargs, (("--sql",), req), (("--params",), {}))
    add("db-runtime-env", cmd_db_runtime_env, (("--project",), req), (("--env",), req))
    add("export-report", cmd_export_report, (("--run",), {"action": "append", "required": True}),
        (("--format",), {"choices": ["html", "xlsx"], "default": "html"}), (("--out",), {}))
    return ap


def main(argv: list[str] | None = None) -> int:
    try:
        args = build_parser().parse_args(argv)
    except CliArgumentError as e:
        print(json.dumps({"ok": False, "error": f"参数错误：{e}"}, ensure_ascii=False))
        return 2
    store = ops.ensure_schema(Store(args.db))
    try:
        data = args.fn(store, args)
        print(dumps({"ok": True, "data": data}))
        return 0
    except Exception as e:  # noqa: BLE001 - CLI 边界统一返回 JSON 错误
        print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}, ensure_ascii=False))
        return 1
    finally:
        store.close()


if __name__ == "__main__":
    sys.exit(main())
