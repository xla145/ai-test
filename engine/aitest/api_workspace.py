"""Persistent API definitions, import revisions, draft editing and direct HTTP trials."""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import re
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

import httpx

from . import apigen, db, hierarchy, linter, openapi
from .api_runtime import auth_resolver, execute_case, redact, sensitive_values
from .models import ApiSpec, TestCase, new_id
from .schema import validate_case


SCHEMA = """
CREATE TABLE IF NOT EXISTS api_source (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL, source TEXT NOT NULL, title TEXT NOT NULL, version TEXT NOT NULL,
 document TEXT NOT NULL, UNIQUE(project_id, source)
);
CREATE TABLE IF NOT EXISTS api_definition (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL, source_id TEXT NOT NULL, method TEXT NOT NULL, path TEXT NOT NULL,
 revision INTEGER NOT NULL, removed INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL,
 UNIQUE(project_id, method, path)
);
CREATE TABLE IF NOT EXISTS api_revision (
 definition_id TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(definition_id, revision)
);
CREATE TABLE IF NOT EXISTS api_debug (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL, env TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL
);
"""


def ensure_schema(store):
    store.conn.executescript(SCHEMA)


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def _project(store, project_id):
    p = store.get_project(project_id)
    if not p or hierarchy.is_group(p):
        raise ValueError("请选择有效的子项目")
    return p


def definitions(store, project_id):
    return [json.loads(r["data"]) | {"removed": bool(r["removed"])} for r in store.conn.execute(
        "SELECT * FROM api_definition WHERE project_id=? ORDER BY path, method", (project_id,))]


def preview(store, project_id, source):
    # Persist the exact parsed document on confirmation, without refetching a mutable URL.
    spec = openapi.load(source)
    doc = openapi.parse(spec)
    if not doc.operations:
        raise ValueError("文档中没有可导入的接口")
    if source.startswith(("http://", "https://")):
        from urllib.parse import urlsplit, urlunsplit
        url = urlsplit(source)
        if url.username or url.password or url.query:
            raise ValueError("文档来源地址不能包含账号或查询凭据，请下载规范后通过文件导入")
        source = urlunsplit((url.scheme, url.netloc, url.path, "", ""))
    else:
        source = str(Path(source).resolve())
    return plan(store, project_id, {"source": source, "document": spec})


def plan(store, project_id, payload):
    doc = openapi.parse(payload["document"])
    existing = {(d["method"], d["path"]): d for d in definitions(store, project_id)}
    changes = []
    keys = set()
    for op in doc.operations:
        key = op.method, op.path
        if key in keys:
            raise ValueError("文档包含重复接口")
        keys.add(key)
        old = existing.get(key)
        if old and old["source"] != payload["source"]:
            raise ValueError(f"{op.method} {op.path} 已属于其他文档来源，请使用原来源更新")
        state = "added" if not old else "unchanged" if old["operation"] == asdict(op) and not old["removed"] else "updated"
        changes.append({"method": op.method, "path": op.path, "summary": op.summary, "change": state})
    for old in existing.values():
        if old["source"] == payload["source"] and (old["method"], old["path"]) not in keys and not old["removed"]:
            changes.append({"method": old["method"], "path": old["path"], "summary": old["summary"], "change": "removed"})
    return {**payload, "title": doc.title, "version": doc.version, "changes": changes}


def import_document(store, project_id, payload):
    _project(store, project_id)
    previewed = plan(store, project_id, payload)
    if not payload.get("source") or not isinstance(payload["source"], str):
        raise ValueError("缺少接口来源")
    doc = openapi.parse(payload["document"])
    old = {(d["method"], d["path"]): d for d in definitions(store, project_id)}
    source_id = "src_" + hashlib.sha256(f"{project_id}:{payload['source']}".encode()).hexdigest()[:20]
    affected = set()
    with store.conn:
        store.conn.execute("INSERT OR REPLACE INTO api_source VALUES (?,?,?,?,?,?)",
                           (source_id, project_id, payload["source"], doc.title, doc.version, _json(payload["document"])))
        for op in doc.operations:
            previous = old.get((op.method, op.path))
            changed = not previous or previous["operation"] != asdict(op) or previous["removed"]
            revision = previous["revision"] + int(changed) if previous else 1
            definition_id = previous["id"] if previous else new_id("api")
            if previous and changed:
                affected.add(definition_id)
            request = asdict(apigen._base_spec(op))
            request.update({"definition_id": definition_id, "definition_revision": revision})
            data = {"id": definition_id, "source": payload["source"], "title": doc.title, "version": doc.version,
                    "method": op.method, "path": op.path, "summary": op.summary or op.operation_id,
                    "module": op.tags[0] if op.tags else "未分组", "revision": revision,
                    "operation": asdict(op), "request": request, "removed": False,
                    "unsupported_body": bool(op.body_media_types) and not any("json" in m for m in op.body_media_types)}
            store.conn.execute("INSERT OR REPLACE INTO api_definition VALUES (?,?,?,?,?,?,?,?)",
                               (definition_id, project_id, source_id, op.method, op.path, revision, 0, _json(data)))
            store.conn.execute("INSERT OR IGNORE INTO api_revision VALUES (?,?,?)", (definition_id, revision, _json(data)))
        keys = {(o.method, o.path) for o in doc.operations}
        for item in old.values():
            if item["source"] == payload["source"] and (item["method"], item["path"]) not in keys:
                store.conn.execute("UPDATE api_definition SET removed=1 WHERE id=?", (item["id"],))
                affected.add(item["id"])
        # Invalidate affected approvals without overwriting manually edited requests.
        for case in store.list_cases(project_id, execution_mode="api"):
            requests = [*([case.api] if case.api else case.api_flow), *case.api_cleanup]
            if any(s and s.definition_id in affected for s in requests):
                case.api_needs_review = True
                case.status = "draft"
                store.conn.execute("UPDATE testcase SET status='draft', data=? WHERE id=?", (_json(case.to_dict()), case.id))
    return {"changes": previewed["changes"], "definitions": definitions(store, project_id)}


def validate_requests(steps, inputs=None, cleanup=None):
    if not steps:
        raise ValueError("请至少添加一个请求步骤")
    if not isinstance(inputs or {}, dict) or not isinstance(steps, list) or not isinstance(cleanup or [], list):
        raise ValueError("场景输入必须为对象，步骤和清理必须为数组")
    known = set((inputs or {}).keys())
    all_extracted = set()
    for index, step in enumerate([*steps, *(cleanup or [])], 1):
        if not isinstance(step, dict) or step.get("method") not in {m.upper() for m in openapi.HTTP_METHODS}:
            raise ValueError(f"第 {index} 步请求方法不合法")
        errors = validate_case({"api": step}, partial=True)
        if errors:
            raise ValueError(f"第 {index} 步配置错误：" + "；".join(errors))
        path = step.get("path", "")
        if not isinstance(path, str) or not path.startswith("/") or path.startswith("//") or "://" in path:
            raise ValueError(f"第 {index} 步必须使用环境内的相对路径")
        for key in ("path_params", "query", "headers", "expected_fields", "extract"):
            if key in step and not isinstance(step[key], dict):
                raise ValueError(f"第 {index} 步 {key} 必须为对象")
        for match in re.findall(r"(?<!\$)\{([^}]+)\}", path):
            if match not in (step.get("path_params") or {}):
                raise ValueError(f"第 {index} 步缺少路径参数 {match}")
        timeout = step.get("timeout", 30)
        if not isinstance(timeout, (int, float)) or not 0 < timeout <= 300:
            raise ValueError("请求超时需为 0–300 秒之间的正数")
        statuses = step.get("expected_status", [])
        if not isinstance(statuses, list) or any(type(s) is not int or not 100 <= s <= 599 for s in statuses):
            raise ValueError("预期状态码必须为 100–599 的整数数组")
        for assertion in step.get("assertions") or []:
            if not isinstance(assertion, dict) or not assertion.get("path") or assertion.get("operator") not in {
                "eq", "ne", "exists", "not_empty", "contains", "gt", "gte", "lt", "lte"}:
                raise ValueError("断言字段或运算符不合法")
        # Only runtime inputs are rendered; response_schema is a contract, not a variable source.
        request_values = {k: step.get(k) for k in ("path", "path_params", "query", "headers", "body", "expected_fields", "assertions")}
        refs = set(re.findall(r"\$\{(\w+)\}", json.dumps(request_values)))
        if refs - known:
            raise ValueError(f"第 {index} 步引用了尚未定义的变量：{', '.join(sorted(refs - known))}")
        for name, dotted in (step.get("extract") or {}).items():
            if not re.fullmatch(r"[A-Za-z_]\w*", name) or not isinstance(dotted, str) or not dotted:
                raise ValueError("提取变量名应为字母或下划线开头，字段路径不能为空")
            if name in all_extracted:
                raise ValueError(f"提取变量重名：{name}")
            all_extracted.add(name)
            known.add(name)


def save_case(store, project_id, payload):
    _project(store, project_id)
    title = str(payload.get("title", "")).strip()
    if not title:
        raise ValueError("请输入用例或场景名称")
    steps = payload.get("steps") or []
    inputs, cleanup = payload.get("inputs") or {}, payload.get("cleanup") or []
    validate_requests(steps, inputs, cleanup)
    old = store.get_case(payload.get("id", ""))
    if payload.get("id") and (not old or old.project_id != project_id):
        raise ValueError("用例不存在或不属于当前项目")
    # Source versions are validated at save time; synchronization is explicit in the UI.
    by_id = {d["id"]: d for d in definitions(store, project_id)}
    stale = False
    for step in [*steps, *cleanup]:
        if step.get("definition_id"):
            definition = by_id.get(step["definition_id"])
            if not definition:
                raise ValueError("引用的接口不属于当前项目")
            stale |= definition["removed"] or definition["revision"] != step.get("definition_revision")
    is_flow = payload.get("kind") == "flow"
    if not is_flow and len(steps) != 1:
        raise ValueError("单接口用例只能包含一个业务请求")
    specs = [ApiSpec(**s) for s in steps]
    c = old or TestCase(title=title, project_id=project_id, type="api", execution_mode="api")
    c.title, c.priority = title, payload.get("priority", "P1")
    c.module_path = payload.get("module_path") or ["业务场景" if is_flow else "接口测试"]
    c.api, c.api_flow = (None, specs) if is_flow else (specs[0], [])
    c.api_inputs, c.api_cleanup = inputs, [ApiSpec(**s) for s in cleanup]
    c.api_variable_scope, c.api_needs_review = "case", stale
    c.api_revision = (old.api_revision + 1) if old else 1
    c.steps = [s.name or f"{s.method} {s.path}" for s in specs]
    c.expected = [f"HTTP {'/'.join(map(str, s.expected_status))}；业务断言符合配置" for s in specs]
    c.preconditions = ["执行环境和测试数据已准备"]
    c.status = "draft"
    errors = validate_case(c.to_dict())
    if errors:
        raise ValueError("；".join(errors))
    lint = linter.lint_cases([c])
    store.upsert_case(c)
    store.replace_lint_issues([c.id], lint.issues)
    return c.to_dict()


def generate_cases(store, project_id, ids):
    _project(store, project_id)
    requested = set(ids)
    items = [d for d in definitions(store, project_id) if d["id"] in requested and not d["removed"]]
    if not requested or len(items) != len(requested):
        raise ValueError("请选择有效的接口")
    if any(d.get("unsupported_body") for d in items):
        raise ValueError("当前仅支持 JSON 请求体，所选接口需要表单、文件或其他请求类型")
    generated, skipped = [], 0
    for definition in items:
        op_data = dict(definition["operation"])
        op_data["params"] = [openapi.Param(**p) for p in op_data["params"]]
        for c in apigen.generate_cases(openapi.Operation(**op_data), project_id):
            # Stable rule identity: repeat generation never overwrites a reviewed/manual variant.
            stable = "tc_" + hashlib.sha256(f"{definition['id']}:{c.title}".encode()).hexdigest()[:12]
            if store.get_case(stable):
                skipped += 1
                continue
            c.id = stable
            c.api.definition_id, c.api.definition_revision = definition["id"], definition["revision"]
            c.api_variable_scope = "case"
            report = linter.lint_cases([c])
            store.upsert_case(c)
            store.replace_lint_issues([c.id], report.issues)
            generated.append(c.id)
    return {"generated": len(generated), "skipped": skipped, "case_ids": generated}



def preview_parameter_cases(store, project_id, draft, options):
    from . import api_casegen
    _project(store, project_id)
    if draft.get("kind") != "single" or len(draft.get("steps", [])) != 1:
        raise ValueError("请选择一个单接口请求生成用例")
    validate_requests(draft["steps"], draft.get("inputs"))
    request = draft["steps"][0]
    definition = next((d for d in definitions(store, project_id) if d["id"] == request.get("definition_id")), None)
    if not definition or definition["removed"]:
        raise ValueError("请先选择已导入的接口，生成需要 OpenAPI 参数约束")
    if definition.get("unsupported_body"):
        raise ValueError("当前生成仅支持 JSON 请求体")
    if definition["revision"] != request.get("definition_revision"):
        raise ValueError("接口定义已更新，请先确认使用当前接口版本再生成")
    if request["method"] != definition["method"] or request["path"] != definition["path"]:
        raise ValueError("当前请求方法或路径与接口定义不一致，请重新选择接口")
    data = dict(definition["operation"])
    data["params"] = [openapi.Param(**p) for p in data["params"]]
    result = api_casegen.generate(definition, openapi.Operation(**data), draft, options)
    for candidate in result["candidates"]:
        validate_requests([candidate["request"]], draft.get("inputs"))
        candidate["existing"] = store.get_case(candidate["key"]) is not None
    return result


def save_parameter_cases(store, project_id, draft, options, keys):
    if not isinstance(keys, list) or not keys or any(not isinstance(k, str) for k in keys):
        raise ValueError("请至少选择一条生成用例")
    result = preview_parameter_cases(store, project_id, draft, options)
    by_key = {c["key"]: c for c in result["candidates"]}
    if set(keys) - by_key.keys():
        raise ValueError("生成预览已变化，请重新生成后选择保存")
    generated, skipped = [], 0
    for key in dict.fromkeys(keys):
        if store.get_case(key):
            skipped += 1
            continue
        item = by_key[key]
        request = item["request"]
        case = TestCase(id=key, project_id=project_id, title=item["title"], type="api", execution_mode="api",
                        priority="P1" if item["polarity"] == "positive" else "P2", module_path=draft.get("module_path") or ["接口测试"],
                        api=ApiSpec(**request), api_inputs=draft.get("inputs") or {}, api_variable_scope="case",
                        preconditions=["环境鉴权和基础业务数据已准备"], steps=[item["scenario"]],
                        expected=[f"HTTP {request.get('expected_status', [])}；业务断言符合配置"], status="draft")
        report = linter.lint_cases([case])
        store.upsert_case(case)
        store.replace_lint_issues([key], report.issues)
        generated.append(key)
    return {"generated": len(generated), "skipped": skipped, "case_ids": generated}


def debug(store, project_id, env_name, payload, confirm_production=False):
    p = _project(store, project_id)
    env_config = hierarchy.effective_environments(store, p).get(env_name)
    if not env_config:
        raise ValueError("项目未配置该环境")
    if env_config.get("production") and not confirm_production:
        raise ValueError("生产环境需要确认后才能执行")
    steps, inputs, cleanup = payload.get("steps") or [], payload.get("inputs") or {}, payload.get("cleanup") or []
    validate_requests(steps, inputs, cleanup)
    definition_map = {d["id"]: d for d in definitions(store, project_id)}
    if any(definition_map.get(s.get("definition_id"), {}).get("unsupported_body") for s in [*steps, *cleanup]):
        raise ValueError("当前仅支持 JSON 请求体，该接口需要其他请求类型")
    env = {"base_url": env_config["base_url"], "auth_header": os.environ.get("AITEST_AUTH_HEADER") or env_config.get("auth_header", "Authorization"),
           "auth_token": os.environ.get("AITEST_AUTH_TOKEN", ""), "timeout": env_config.get("timeout", 30), "api_crypto": env_config.get("api_crypto")}
    runtime_case = {"steps": steps, "cleanup": cleanup, "inputs": inputs, "variable_scope": "case"}
    hooks_path = Path(p.workspace_path) / "aitest_hooks.py"
    hooks = {"request": [], "response": []}
    if hooks_path.exists():
        spec = importlib.util.spec_from_file_location("aitest_project_hooks", hooks_path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        for event, function in (("request", "before_request"), ("response", "after_response")):
            if hasattr(module, function):
                hooks[event].append(getattr(module, function))
    # Database setup/check helpers read the same runtime settings as exported scripts.
    previous_databases = os.environ.get("AITEST_DATABASES")
    os.environ["AITEST_DATABASES"] = db.runtime_env(db.configs_for_env(env_config)).get("AITEST_DATABASES", "{}")
    try:
        with httpx.Client(base_url=env["base_url"].rstrip("/") + "/", timeout=env["timeout"], event_hooks=hooks) as client:
            resolver = auth_resolver(client, env, env_config.get("api_login"), json.loads(os.environ.get("AITEST_ROLES") or "[]"),
                                     json.loads(os.environ.get("AITEST_ROLE_TOKENS") or "{}"))
            result = execute_case(runtime_case, client, env, {}, resolver)
    finally:
        if previous_databases is None:
            os.environ.pop("AITEST_DATABASES", None)
        else:
            os.environ["AITEST_DATABASES"] = previous_databases
    result.update({"id": new_id("debug"), "env": env_name, "created_at": datetime.now(timezone.utc).isoformat(),
                   "title": payload.get("title") or "临时调试", "snapshot": redact(runtime_case, [env["auth_token"], *json.loads(os.environ.get("AITEST_ROLE_TOKENS") or "{}").values(), *sensitive_values(json.loads(os.environ.get("AITEST_ROLES") or "[]"))])})
    with store.conn:
        store.conn.execute("INSERT INTO api_debug VALUES (?,?,?,?,?)", (result["id"], project_id, env_name, result["created_at"], _json(result)))
        store.conn.execute("DELETE FROM api_debug WHERE project_id=? AND id NOT IN (SELECT id FROM api_debug WHERE project_id=? ORDER BY created_at DESC LIMIT 50)",
                           (project_id, project_id))
    return result


def dispatch(store, project_id, action, payload):
    ensure_schema(store)
    _project(store, project_id)
    if action == "list":
        return definitions(store, project_id)
    if action == "preview":
        return preview(store, project_id, payload["source"])
    if action == "import":
        return import_document(store, project_id, payload)
    if action == "save-case":
        return save_case(store, project_id, payload)
    if action == "generate":
        return generate_cases(store, project_id, payload["ids"])
    if action == "preview-parameter-cases":
        return preview_parameter_cases(store, project_id, payload["draft"], payload.get("options", {}))
    if action == "save-parameter-cases":
        return save_parameter_cases(store, project_id, payload["draft"], payload.get("options", {}), payload.get("keys", []))
    if action == "debug":
        return debug(store, project_id, payload["env"], payload["request"], payload.get("confirmProduction", False))
    if action == "history":
        return [json.loads(r[0]) for r in store.conn.execute("SELECT data FROM api_debug WHERE project_id=? ORDER BY created_at DESC LIMIT 50", (project_id,))]
    raise ValueError("不支持的接口工作台操作")
