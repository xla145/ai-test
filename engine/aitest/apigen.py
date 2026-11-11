"""接口用例与 pytest 脚本生成（第 8 节）。

- 生成用例：正向、必填缺失、边界值、类型错误、鉴权、幂等。
- 生成脚本：pytest + httpx，数据驱动（用例数据与脚本分离），支持接口间依赖。

这里是确定性的基线生成；agent 在此基础上补充业务场景用例并关联需求点。
"""

from __future__ import annotations

import copy
import json
import shutil
from importlib import resources
from pathlib import Path
from typing import Any

from .models import ApiSpec, CaseType, ExecutionMode, TestCase
from .openapi import ApiDoc, Operation

# --------------------------------------------------------------------------- 样例值


def sample_value(schema: dict[str, Any] | None, name: str = "") -> Any:
    s = schema or {}
    if "example" in s:
        return s["example"]
    if "default" in s:
        return s["default"]
    if s.get("enum"):
        return s["enum"][0]
    for key in ("allOf", "anyOf", "oneOf"):
        if s.get(key):
            merged: dict[str, Any] = {}
            for sub in s[key] if key == "allOf" else s[key][:1]:
                merged.update(sub)
                if sub.get("properties"):
                    merged.setdefault("properties", {}).update(sub["properties"])
            return sample_value(merged, name)
    t = s.get("type") or ("object" if "properties" in s else "string")
    if isinstance(t, list):
        t = next((x for x in t if x != "null"), "string")
    if t == "object":
        props = s.get("properties", {})
        required = set(s.get("required", props.keys()))
        return {k: sample_value(v, k) for k, v in props.items() if k in required}
    if t == "array":
        n = max(1, s.get("minItems", 1))
        return [sample_value(s.get("items"), name) for _ in range(n)]
    if t == "integer":
        return int(s.get("minimum", 1))
    if t == "number":
        return float(s.get("minimum", 1))
    if t == "boolean":
        return True
    fmt = s.get("format", "")
    if fmt == "email":
        return "tester@example.com"
    if fmt == "date":
        return "2026-01-01"
    if fmt == "date-time":
        return "2026-01-01T00:00:00Z"
    if fmt == "uuid":
        return "00000000-0000-4000-8000-000000000001"
    base = f"test_{name}" if name else "test"
    min_len = s.get("minLength", 0)
    max_len = s.get("maxLength")
    if len(base) < min_len:
        base = base + "x" * (min_len - len(base))
    if max_len is not None and len(base) > max_len:
        base = base[:max_len] if max_len > 0 else ""
    return base


def _wrong_type(schema: dict[str, Any]) -> Any:
    t = schema.get("type", "string")
    return "not-a-number" if t in ("integer", "number") else (12345 if t == "string" else "wrong-type")


def _boundaries(schema: dict[str, Any]) -> list[tuple[str, Any, bool]]:
    """返回 (说明, 值, 是否合法)。"""
    out: list[tuple[str, Any, bool]] = []
    t = schema.get("type")
    if t in ("integer", "number"):
        step = 1 if t == "integer" else 0.01
        if "minimum" in schema:
            out += [("最小值", schema["minimum"], True), ("小于最小值", schema["minimum"] - step, False)]
        if "maximum" in schema:
            out += [("最大值", schema["maximum"], True), ("大于最大值", schema["maximum"] + step, False)]
    if t == "string":
        if "minLength" in schema and schema["minLength"] > 0:
            out += [("最小长度", "a" * schema["minLength"], True),
                    ("小于最小长度", "a" * (schema["minLength"] - 1), False)]
        if "maxLength" in schema:
            out += [("最大长度", "a" * schema["maxLength"], True),
                    ("超过最大长度", "a" * (schema["maxLength"] + 1), False)]
    return out


# --------------------------------------------------------------------------- 用例生成


def _base_spec(op: Operation) -> ApiSpec:
    path_params = {p.name: sample_value(p.schema, p.name) for p in op.params if p.location == "path"}
    query = {p.name: sample_value(p.schema, p.name) for p in op.params if p.location == "query" and p.required}
    headers = {p.name: str(sample_value(p.schema, p.name)) for p in op.params if p.location == "header" and p.required}
    body = sample_value(op.body_schema) if op.body_schema is not None else None
    return ApiSpec(
        method=op.method, path=op.path, path_params=path_params, query=query, headers=headers, body=body,
        auth=op.secured, expected_status=[op.success_status], response_schema=op.success_schema,
        operation_id=op.operation_id,
    )


def _client_error_statuses(op: Operation) -> list[int]:
    codes = sorted(int(c) for c in op.responses if c.isdigit() and c.startswith("4") and c not in ("401", "403"))
    return codes or [400, 422]


def _case(op: Operation, scenario: str, spec: ApiSpec, priority: str, steps: list[str], expected: list[str],
          project_id: str, category: str = "功能测试") -> TestCase:
    module = op.tags[0] if op.tags else op.path.strip("/").split("/")[0] or "root"
    name = op.summary or op.operation_id
    return TestCase(
        title=f"{module}-{name}-{scenario}",
        project_id=project_id,
        type=CaseType.API.value,
        priority=priority,
        category=category,
        module_path=[module],
        execution_mode=ExecutionMode.API.value,
        steps=steps,
        expected=expected,
        api=spec,
    )


def generate_cases(op: Operation, project_id: str = "", requirement_ids: list[str] | None = None) -> list[TestCase]:
    cases: list[TestCase] = []
    base = _base_spec(op)
    req = f"{op.method} {op.path}"
    bad = _client_error_statuses(op)

    # 正向
    cases.append(_case(op, "正向", copy.deepcopy(base), "P0",
                       [f"使用合法参数调用 {req}"],
                       [f"返回 {op.success_status}，响应符合接口定义的结构"], project_id))

    # 必填缺失
    for p in op.params:
        if p.required and p.location in ("query", "header"):
            spec = copy.deepcopy(base)
            spec.query.pop(p.name, None) if p.location == "query" else spec.headers.pop(p.name, None)
            spec.expected_status, spec.response_schema = bad, None
            cases.append(_case(op, f"缺少必填参数{p.name}", spec, "P1",
                               [f"调用 {req}，不传必填参数 {p.name}"], [f"返回 {'/'.join(map(str, bad))}"], project_id))
    if op.body_schema and isinstance(base.body, dict):
        for field_name in op.body_schema.get("required", []):
            spec = copy.deepcopy(base)
            spec.body.pop(field_name, None)
            spec.expected_status, spec.response_schema = bad, None
            cases.append(_case(op, f"缺少必填字段{field_name}", spec, "P1",
                               [f"调用 {req}，请求体缺少必填字段 {field_name}"],
                               [f"返回 {'/'.join(map(str, bad))}"], project_id))

    # 边界值与类型错误（query 参数与请求体一级字段）
    targets: list[tuple[str, str, dict[str, Any]]] = [("query", p.name, p.schema) for p in op.params if p.location == "query"]
    if op.body_schema and isinstance(base.body, dict):
        targets += [("body", k, v) for k, v in (op.body_schema.get("properties") or {}).items()]
    for where, name, schema in targets:
        for label, value, valid in _boundaries(schema or {}):
            spec = copy.deepcopy(base)
            (spec.query if where == "query" else spec.body)[name] = value
            if not valid:
                spec.expected_status, spec.response_schema = bad, None
            cases.append(_case(op, f"{name}{label}", spec, "P2",
                               [f"调用 {req}，{name} 取{label}：{value!r}"],
                               [f"返回 {'/'.join(map(str, spec.expected_status))}"], project_id))
        if (schema or {}).get("type") in ("integer", "number", "string"):
            spec = copy.deepcopy(base)
            (spec.query if where == "query" else spec.body)[name] = _wrong_type(schema)
            spec.expected_status, spec.response_schema = bad, None
            cases.append(_case(op, f"{name}类型错误", spec, "P2",
                               [f"调用 {req}，{name} 传入错误类型"],
                               [f"返回 {'/'.join(map(str, bad))}"], project_id))

    # 鉴权
    if op.secured:
        spec = copy.deepcopy(base)
        spec.auth = False
        spec.expected_status, spec.response_schema = [401, 403], None
        cases.append(_case(op, "未鉴权", spec, "P0", [f"不携带凭据调用 {req}"], ["返回 401/403"],
                           project_id, category="安全相关"))

    # 幂等
    if op.method in ("PUT", "DELETE"):
        spec = copy.deepcopy(base)
        spec.expected_status = sorted({op.success_status, 200, 204} | ({404} if op.method == "DELETE" else set()))
        spec.response_schema = None
        cases.append(_case(op, "重复调用幂等", spec, "P2",
                           [f"使用相同参数调用 {req}", f"再次使用相同参数调用 {req}"],
                           [f"返回 {op.success_status}", "第二次调用不产生副作用，返回成功或资源不存在"], project_id))

    for c in cases:
        c.requirement_ids = list(requirement_ids or [])
    return cases


def generate_suite(doc: ApiDoc, project_id: str = "") -> list[TestCase]:
    out: list[TestCase] = []
    for op in doc.operations:
        out += generate_cases(op, project_id)
    return out


# --------------------------------------------------------------------------- 脚本生成


def _template(name: str) -> str:
    return resources.files("aitest").joinpath("templates", name).read_text(encoding="utf-8")


def write_pytest_suite(cases: list[TestCase], out_dir: str | Path, suite: str = "api") -> dict[str, Any]:
    """生成数据驱动的 pytest 脚本。返回生成的文件路径。

    目录结构::

        out_dir/
          conftest.py          # httpx client、环境与鉴权注入、项目 hook
          _aitest_schema.py    # JSON Schema 断言（无依赖）
          data/<suite>.json    # 用例数据
          test_<suite>.py      # 参数化脚本，文件头注释列出用例 ID
    """
    out = Path(out_dir)
    (out / "data").mkdir(parents=True, exist_ok=True)
    api_cases = [c for c in cases if c.api is not None]
    data = [
        {"case_id": c.id, "title": c.title, "priority": c.priority, **c.to_dict()["api"]}
        for c in api_cases
    ]
    data_file = out / "data" / f"{suite}.json"
    data_file.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

    conftest = out / "conftest.py"
    conftest.write_text(_template("conftest.py.tpl"), encoding="utf-8")
    shutil.copyfile(Path(str(resources.files("aitest").joinpath("schema.py"))), out / "_aitest_schema.py")
    shutil.copyfile(Path(str(resources.files("aitest").joinpath("db.py"))), out / "_aitest_db.py")

    header = "\n".join(f"#   {c.id}  {c.title}" for c in api_cases)
    test_file = out / f"test_{suite}.py"
    test_file.write_text(_template("test_api.py.tpl").replace("{{SUITE}}", suite).replace("{{CASE_IDS}}", header),
                         encoding="utf-8")
    return {"data": str(data_file), "test": str(test_file), "conftest": str(conftest), "cases": len(data)}
