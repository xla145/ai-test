"""Offline parameter-case generation. No HTTP calls or model invocation."""
from __future__ import annotations

import copy
import hashlib
import json
import re
import warnings
from functools import lru_cache

from . import apigen
from .api_runtime import render

ENGINE = "Schemathesis 4.33.4"
_AUTH = re.compile(r"authorization|cookie|token|password|secret|api.?key|credential", re.I)
_MISSING = object()


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, allow_nan=False, separators=(",", ":"))


def _json_schema(schema):
    """Normalize OAS 3.0 nullability / exclusive bounds for local validation."""
    if isinstance(schema, list):
        return [_json_schema(s) for s in schema]
    if not isinstance(schema, dict):
        return schema
    out = copy.deepcopy(schema)
    for keyword in ("properties", "patternProperties", "definitions", "$defs", "dependentSchemas"):
        if isinstance(out.get(keyword), dict):
            out[keyword] = {name: _json_schema(value) for name, value in out[keyword].items()}
    for keyword in ("allOf", "anyOf", "oneOf", "prefixItems"):
        if isinstance(out.get(keyword), list):
            out[keyword] = [_json_schema(value) for value in out[keyword]]
    for keyword in ("items", "additionalProperties", "not", "contains", "if", "then", "else", "propertyNames"):
        if keyword in out:
            out[keyword] = _json_schema(out[keyword])
    if out.pop("nullable", False) and "type" in out:
        out["type"] = list(dict.fromkeys([*(out["type"] if isinstance(out["type"], list) else [out["type"]]), "null"]))
    for bound in ("Minimum", "Maximum"):
        exclusive, inclusive = "exclusive" + bound, bound.lower()
        if type(out.get(exclusive)) is bool:
            enabled = out.pop(exclusive)
            if enabled and inclusive in out:
                out[exclusive] = out.pop(inclusive)
    return out


@lru_cache(maxsize=256)
def _validator(encoded_schema):
    from jsonschema_rs import Draft202012Validator
    return Draft202012Validator(_json_schema(json.loads(encoded_schema)), validate_formats=True, offline=True)


def _valid(value, schema):
    return _validator(canonical(schema)).is_valid(value)


def _transport_valid(value, schema, location):
    # Query/path/header scalars arrive as text; changing str->int alone is not
    # an invalid string parameter after HTTP serialization.
    if location != "body":
        kind = schema.get("type") if isinstance(schema, dict) else None
        text = "" if value is None else str(value)
        if kind == "string":
            value = text
        elif kind in ("integer", "number") and isinstance(value, str):
            try:
                value = int(text) if kind == "integer" else float(text)
            except ValueError:
                return False
        elif kind == "boolean" and isinstance(value, str) and text.lower() in ("true", "false"):
            value = text.lower() == "true"
    return _valid(value, schema)


def _external_ref(value):
    if isinstance(value, dict):
        return any((k == "$ref" and isinstance(v, str) and not v.startswith("#/")) or _external_ref(v) for k, v in value.items())
    return isinstance(value, list) and any(_external_ref(v) for v in value)


@lru_cache(maxsize=256)
def _framework_values(encoded_schema, negative, random_seed):
    # Use the public request strategy API, never call()/call_and_validate().
    import schemathesis
    from schemathesis.generation import GenerationMode
    from hypothesis import given, seed, settings, Phase, HealthCheck
    schema = json.loads(encoded_schema)
    document = {"openapi": "3.1.0", "info": {"title": "Parameter generation", "version": "1"}, "paths": {"/value": {"post": {
        "requestBody": {"required": True, "content": {"application/json": {"schema": _json_schema(schema)}}},
        "responses": {"200": {"description": "OK"}},
    }}}}
    op = schemathesis.openapi.from_dict(document)["/value"]["POST"]
    mode = GenerationMode.NEGATIVE if negative else GenerationMode.POSITIVE
    def usable(case):
        try:
            data = canonical(case.body)
            return len(data) <= 8192 and _valid(case.body, schema) != negative
        except (ValueError, TypeError):
            return False
    values = []
    @seed(random_seed)
    @settings(max_examples=2, database=None, deadline=None, phases=[Phase.generate],
              suppress_health_check=[HealthCheck.filter_too_much, HealthCheck.too_slow])
    @given(op.as_strategy(generation_mode=mode).filter(usable))
    def collect(case):
        value = canonical(case.body)
        if value not in values:
            values.append(value)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        collect()
    return tuple(values)


def _get(value, path):
    for key in path:
        if isinstance(value, dict) and key in value:
            value = value[key]
        else:
            return _MISSING
    return value


def _set(value, path, item):
    if not path:
        return copy.deepcopy(item)
    if not isinstance(value, dict):
        value = {}
    cur = value
    for key in path[:-1]:
        if not isinstance(cur.get(key), dict):
            cur[key] = {}
        cur = cur[key]
    if item is _MISSING:
        cur.pop(path[-1], None)
    else:
        cur[path[-1]] = copy.deepcopy(item)
    return value


def _targets(operation, base):
    result = []
    for p in operation.params:
        if p.location not in ("query", "path", "header") or _AUTH.search(p.name):
            continue
        result.append(({"path": "path_params", "query": "query", "header": "headers"}[p.location], [p.name], p.schema, p.required, p.location != "path"))
    def walk(schema, path, required=False):
        current = _get(base.get("body"), path)
        if isinstance(current, dict) and isinstance(schema, dict) and schema.get("properties"):
            for name, child in schema["properties"].items():
                if (not isinstance(child, dict) or not child.get("readOnly")) and not _AUTH.search(name):
                    walk(child, [*path, name], name in schema.get("required", []))
        else:
            result.append(("body", path, schema, required, bool(path)))
    if operation.body_schema:
        walk(operation.body_schema, [], operation.body_required)
    return result


def _variants(schema):
    """Readable single-constraint mutations supplement framework strategies."""
    if not isinstance(schema, dict):
        return []
    values = [("空值", None, False)]
    kind = schema.get("type")
    if kind == "string":
        values += [("空字符串", "", None)]
        for key, delta, label, valid in [("minLength", 0, "最小长度", True), ("minLength", -1, "低于最小长度", False),
                                          ("maxLength", 0, "最大长度", True), ("maxLength", 1, "超过最大长度", False)]:
            n = schema.get(key, -100) + delta
            if 0 <= n <= 4096:
                values.append((label, "a" * n, valid))
    if kind in ("integer", "number"):
        step = 1 if kind == "integer" else 0.01
        for key, direction, label in [("minimum", -1, "最小值"), ("maximum", 1, "最大值")]:
            if key in schema and isinstance(schema[key], (int, float)):
                values += [(label, schema[key], True), ("超出" + label, schema[key] + direction * step, False)]
        for key, direction in [("exclusiveMinimum", -1), ("exclusiveMaximum", 1)]:
            bound = schema.get(key)
            if type(bound) in (int, float):
                values += [("等于排他边界", bound, False), ("排他边界内", bound - direction * step, True)]
    if kind == "array":
        item = apigen.sample_value(schema.get("items"))
        values.append(("空数组", [], None))
        for key, delta, label, valid in [("minItems", 0, "最少元素", True), ("minItems", -1, "少于最少元素", False),
                                          ("maxItems", 0, "最多元素", True), ("maxItems", 1, "超过最多元素", False)]:
            n = schema.get(key, -100) + delta
            if 0 <= n <= 20:
                values.append((label, [copy.deepcopy(item) for _ in range(n)], valid))
    for item in schema.get("enum", [])[:10]:
        values.append((f"枚举值 {item}", item, True))
    if schema.get("enum"):
        values.append(("非法枚举", "__invalid_enum__", False))
    if kind:
        values.append(("类型错误", "not-a-number" if kind in ("integer", "number", "boolean", "object", "array") else 12345, False))
    return values


def generate(definition, operation, draft, options):
    try:
        import schemathesis  # noqa: F401
    except ImportError as exc:
        raise ValueError("参数用例生成需要 Schemathesis 4.33.4 和 Python 3.11+，请安装引擎依赖后重启应用") from exc
    limit = options.get("max_cases", 30)
    random_seed = options.get("seed", 20261113)
    if type(limit) is not int or not 1 <= limit <= 100 or type(random_seed) is not int or not 0 <= random_seed <= 2**32 - 1:
        raise ValueError("生成数量应为 1–100，随机种子应为 0–4294967295 的整数")
    mode = options.get("response_mode", "http")
    negative = options.get("include_negative", True)
    if mode not in ("http", "business") or type(negative) is not bool:
        raise ValueError("生成选项不合法")
    if mode == "business":
        if not re.fullmatch(r"[\w-]+(?:\.[\w-]+)*", options.get("code_path", "")):
            raise ValueError("请填写业务码字段路径，如 code 或 data.code")
        for key in ["success_code", *(["error_code"] if negative else [])]:
            if key not in options or type(options[key]) not in (str, int, float, bool, type(None)):
                raise ValueError("请明确填写成功及参数错误业务码，不会自动猜测错误码")
        if negative and options["success_code"] == options["error_code"]:
            raise ValueError("成功和参数错误业务码不能相同")
    if _external_ref(operation.body_schema) or any(_external_ref(p.schema) for p in operation.params):
        raise ValueError("生成不访问外部 Schema 引用，请先将外部引用内联到 OpenAPI 文档")
    base = copy.deepcopy(draft["steps"][0])
    base["headers"] = {k: v for k, v in base.get("headers", {}).items() if not _AUTH.search(k)}
    for name in ("extract", "db_setup", "db_checks"):
        base.pop(name, None)
    candidates, seen, notices = [], set(), []
    def add(label, request, valid):
        if not valid and not negative:
            return
        if len(candidates) >= limit:
            return
        request = copy.deepcopy(request)
        if not valid:
            statuses = [code for code in (400, 422) if str(code) in operation.responses] or [400, 422]
            request.update(expected_status=statuses, expected_fields={}, assertions=[], response_schema=None)
        if mode == "business":
            request["expected_status"] = [operation.success_status]
            request["expected_fields"] = {**request.get("expected_fields", {}), options["code_path"]: options["success_code" if valid else "error_code"]}
        fingerprint = canonical({"request": request, "inputs": draft.get("inputs", {})})
        if fingerprint in seen:
            return
        seen.add(fingerprint)
        key = "tc_" + hashlib.sha256((definition["id"] + fingerprint).encode()).hexdigest()[:20]
        prefix = draft.get("title") or definition["summary"]
        if not prefix.startswith(definition["module"] + "-"):
            prefix = definition["module"] + "-" + prefix
        title = f"{prefix}-{label}"
        candidates.append({"key": key, "title": title, "scenario": label, "polarity": "positive" if valid else "negative", "request": request})
    add("当前参数正向", base, True)
    if operation.body_required:
        request = copy.deepcopy(base)
        request["body"] = None
        add("缺少请求体", request, False)
    targets = _targets(operation, base)
    if not targets:
        notices.append("接口文档未声明可变参数，仅生成当前请求；补充 OpenAPI 参数约束后可扩展覆盖。")
    for location, path, schema, required, _ in targets:
        current = _get(base.get(location), path)
        if current is _MISSING:
            if required:
                notices.append(f"基础请求缺少 {location}.{'.'.join(path)}，请先补齐正向请求参数。")
        elif not _transport_valid(render(current, draft.get("inputs", {})), schema, location):
            notices.append(f"基础参数 {location}.{'.'.join(path)} 不符合文档约束，请检查基础请求后再试跑正向用例。")
    for location, path, schema, required, removable in targets:
        if removable and _get(base.get(location), path) is not _MISSING:
            request = copy.deepcopy(base)
            request[location] = _set(request.get(location), path, _MISSING)
            add(f"{location}.{'.'.join(path)} {'缺少必填' if required else '省略可选参数'}", request, not required)
    rule_limit = max(len(candidates), limit - min(8, max(2, len(targets) * 2)))
    for location, path, schema, _, _ in targets:
        if len(candidates) >= rule_limit:
            break
        label = location + ("." + ".".join(path) if path else "")
        for scenario, value, intended in _variants(schema):
            if len(candidates) >= rule_limit:
                break
            valid = _transport_valid(value, schema, location)
            if intended is not None and valid != intended:
                continue
            # Path/header values must be serializable as HTTP scalars.
            if location in ("path_params", "headers") and (value is None or isinstance(value, (dict, list))):
                continue
            if location == "query" and isinstance(value, dict):
                continue
            request = copy.deepcopy(base)
            request[location] = _set(request.get(location), path, value)
            if location == "headers":
                request[location] = {k: str(v) for k, v in request[location].items()}
            add(f"{label} {scenario}", request, valid)
    # Framework samples cover patterns, formats, composed and nested schemas.
    for location, path, schema, _, _ in targets:
        if len(candidates) >= limit:
            break
        label = location + ("." + ".".join(path) if path else "")
        for invalid in ([False, True] if negative else [False]):
            try:
                values = _framework_values(canonical(schema), invalid, random_seed)
            except Exception:
                notices.append(f"{label} 无法生成{'反例' if invalid else '样本'}，已保留可用的规则用例")
                continue
            for index, encoded in enumerate(values, 1):
                value = json.loads(encoded)
                if _transport_valid(value, schema, location) == invalid:
                    continue
                if location in ("path_params", "headers") and (value is None or isinstance(value, (dict, list))):
                    continue
                if location == "query" and isinstance(value, dict):
                    continue
                request = copy.deepcopy(base)
                request[location] = _set(request.get(location), path, value)
                if location == "headers":
                    request[location] = {k: str(v) for k, v in request[location].items()}
                add(f"{label} Schema {'反例' if invalid else '正例'} {index}", request, not invalid)
    if len(candidates) >= limit:
        notices.append(f"已达到 {limit} 条上限，可提高数量或按字段分批生成；不代表已覆盖所有约束")
    notices.append("仅生成草稿，不发送请求；请确认基础参数可用，真实数据及业务关系需要人工检查。")
    if mode == "http":
        notices.append("当前按 HTTP 状态码断言；HTTP 200 包装业务错误的系统请选择业务码模式。")
    return {"engine": ENGINE, "seed": random_seed, "candidates": candidates, "notices": list(dict.fromkeys(notices))}
