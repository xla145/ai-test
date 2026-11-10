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

from . import apigen, docparser, importer, linter, openapi, router, runner, workspace
from .models import AgentSession, Project, TestCase, dumps
from .store import Store

DEFAULT_DB = os.environ.get("AITEST_DB", str(Path.home() / ".aitest" / "aitest.db"))


def _project(store: Store, project_id: str) -> Project:
    p = store.get_project(project_id)
    if p is None:
        raise KeyError(f"项目不存在：{project_id}")
    return p


def cmd_init_project(store: Store, a: argparse.Namespace) -> Any:
    envs = json.loads(a.environments) if a.environments else {}
    p = Project(name=a.name, workspace_path=str(Path(a.workspace).resolve()), environments=envs)
    workspace.init_workspace(p.workspace_path, p.name)
    return asdict(store.add_project(p))


def cmd_list_projects(store: Store, a: argparse.Namespace) -> Any:
    return [asdict(p) for p in store.list_projects()]


def cmd_parse_requirement(store: Store, a: argparse.Namespace) -> Any:
    _project(store, a.project)
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
    _project(store, a.project)
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
    return [asdict(i) for i in store.list_lint_issues(a.case)]


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
    return {"case": case.to_dict(), "issues": [asdict(i) for i in report.issues]}


def cmd_export_excel(store: Store, a: argparse.Namespace) -> Any:
    cases = store.list_cases(a.project)
    return {"path": str(importer.export_excel(cases, a.out)), "cases": len(cases)}


def cmd_create_case(store: Store, a: argparse.Namespace) -> Any:
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
    merged = {**case.to_dict(), **json.loads(a.json), "id": case.id, "project_id": case.project_id}
    return store.upsert_case(TestCase.from_dict(merged)).to_dict()


def cmd_list_cases(store: Store, a: argparse.Namespace) -> Any:
    cases = store.list_cases(a.project, type=a.type, priority=a.priority, execution_mode=a.execution_mode,
                             status=a.status, lint_status=a.lint_status)
    return [c.to_dict() for c in cases]


def cmd_link_requirement(store: Store, a: argparse.Namespace) -> Any:
    return store.link_requirement(a.case, a.requirement).to_dict()


def cmd_route(store: Store, a: argparse.Namespace) -> Any:
    cases = store.list_cases(a.project)
    counts = router.route_all(cases, overwrite=a.overwrite)
    for c in cases:
        store.upsert_case(c, validate=False)
    return counts


def cmd_generate_api_cases(store: Store, a: argparse.Namespace) -> Any:
    _project(store, a.project)
    doc = openapi.parse_openapi(a.openapi)
    cases = apigen.generate_suite(doc, a.project)
    if a.operation:
        cases = [c for c in cases if c.api and c.api.operation_id == a.operation]
    for c in cases:
        store.upsert_case(c)
    return {"generated": len(cases), "case_ids": [c.id for c in cases]}


def cmd_write_api_suite(store: Store, a: argparse.Namespace) -> Any:
    p = _project(store, a.project)
    cases = store.list_cases(a.project, execution_mode="api")
    issues = store.list_lint_issues()
    eligible = [c for c in cases if c.api and c.status != "deprecated" and linter.can_generate_script(c, issues)]
    if a.reviewed_only:
        eligible = [c for c in eligible if c.status == "reviewed"]
    out = Path(p.workspace_path) / "scripts" / "api"
    files = apigen.write_pytest_suite(eligible, out, a.suite)
    files["version"] = workspace.commit(p.workspace_path, f"生成接口脚本 {a.suite}（{len(eligible)} 条）")
    files["skipped"] = len(cases) - len(eligible)
    return files


def cmd_run_api_suite(store: Store, a: argparse.Namespace) -> Any:
    p = _project(store, a.project)
    env_cfg = (p.environments or {}).get(a.env)
    if env_cfg is None:
        raise KeyError(f"项目未配置环境：{a.env}")
    env = runner.EnvConfig(
        base_url=env_cfg["base_url"],
        auth_header=os.environ.get("AITEST_AUTH_HEADER") or env_cfg.get("auth_header", "Authorization"),
        auth_token=os.environ.get("AITEST_AUTH_TOKEN", ""),
        timeout=float(env_cfg.get("timeout", 30)),
    )
    suite_dir = Path(p.workspace_path) / "scripts" / "api"
    run, results = runner.run_pytest(suite_dir, env, project_id=p.id, env_name=a.env,
                                     report_dir=Path(p.workspace_path) / "reports")
    store.save_run(run, results)
    return {"run_id": run.id, **run.result}


def cmd_summarize_failures(store: Store, a: argparse.Namespace) -> Any:
    results = [r for r in store.list_run_results(a.run) if r.status in ("failed", "error")]
    return [{"case_id": r.case_id, "failure_type": r.failure_type, "message": r.message[:1500]} for r in results]


def cmd_agent_session(store: Store, a: argparse.Namespace) -> Any:
    s = AgentSession(codex_thread_id=a.thread, purpose=a.purpose, project_id=a.project)
    store.add_agent_session(s)
    return asdict(s)


def cmd_add_tokens(store: Store, a: argparse.Namespace) -> Any:
    store.add_token_usage(a.session, a.tokens)
    return {"session": a.session, "added": a.tokens}


def cmd_token_usage(store: Store, a: argparse.Namespace) -> Any:
    return {"project": a.project, "tokens": store.project_token_usage(a.project)}


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="aitest", description="AI 测试客户端引擎")
    ap.add_argument("--db", default=DEFAULT_DB, help="SQLite 路径（默认 ~/.aitest/aitest.db 或 $AITEST_DB）")
    sub = ap.add_subparsers(dest="command", required=True)

    def add(name: str, fn: Callable, *args: tuple[tuple, dict]) -> None:
        sp = sub.add_parser(name)
        for flags, kw in args:
            sp.add_argument(*flags, **kw)
        sp.set_defaults(fn=fn)

    req = {"required": True}
    add("init-project", cmd_init_project, (("--name",), req), (("--workspace",), req), (("--environments",), {}))
    add("list-projects", cmd_list_projects)
    add("parse-requirement", cmd_parse_requirement, (("--project",), req), (("--file",), req))
    add("list-sections", cmd_list_sections, (("--project",), req), (("--query",), {}),
        (("--full",), {"action": "store_true"}))
    add("parse-openapi", cmd_parse_openapi, (("--file",), req))
    add("import-excel", cmd_import_excel, (("--project",), req), (("--file",), req), (("--sheet",), {}),
        (("--column-map",), {}))
    add("lint", cmd_lint, (("--project",), req), (("--case-ids",), {}),
        (("--p0-threshold",), {"type": float, "default": 0.25}), (("--with-issues",), {"action": "store_true"}))
    add("list-issues", cmd_list_issues, (("--case",), {}))
    add("apply-fix", cmd_apply_fix, (("--case",), req), (("--field",), req), (("--value",), req))
    add("export-excel", cmd_export_excel, (("--project",), req), (("--out",), req))
    add("create-case", cmd_create_case, (("--project",), req), (("--json",), req))
    add("update-case", cmd_update_case, (("--case",), req), (("--json",), req))
    add("list-cases", cmd_list_cases, (("--project",), req), *[((f"--{k}",), {}) for k in
                                                               ("type", "priority", "execution-mode", "status", "lint-status")])
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
    return ap


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    store = Store(args.db)
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
