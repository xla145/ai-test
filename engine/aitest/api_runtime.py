"""Shared HTTP execution for the workbench and exported pytest suites."""
from __future__ import annotations

import json
import re
import time
from typing import Any

try:  # Exported suites carry their own schema validator.
    from _aitest_schema import validate
except ModuleNotFoundError:
    from aitest.schema import validate

try:
    from _aitest_crypto import prepare, response_body
except ModuleNotFoundError:
    from aitest.api_crypto import prepare, response_body

_VAR = re.compile(r"\$\{(\w+)\}")
_SENSITIVE = re.compile(r"authorization|cookie|token|password|passwd|secret|api.?key|credential|encrypt-key", re.I)


def render(value, variables, strict=False):
    if isinstance(value, str):
        missing = [k for k in _VAR.findall(value) if k not in variables]
        if strict and missing:
            raise ValueError("未定义变量：" + ", ".join(missing))
        whole = _VAR.fullmatch(value)
        if whole and whole.group(1) in variables:
            return variables[whole.group(1)]
        return _VAR.sub(lambda m: str(variables.get(m.group(1), m.group(0))), value)
    if isinstance(value, dict):
        return {k: render(v, variables, strict) for k, v in value.items()}
    if isinstance(value, list):
        return [render(v, variables, strict) for v in value]
    return value


def pick(data, dotted):
    cur = data
    for part in [p for p in dotted.split(".") if p]:
        cur = cur[int(part)] if isinstance(cur, list) else cur[part]
    return cur


def sensitive_values(value):
    values = []
    if isinstance(value, dict):
        for key, item in value.items():
            if _SENSITIVE.search(str(key)) and isinstance(item, (str, int, float)) and item:
                values.append(str(item))
            values.extend(sensitive_values(item))
    elif isinstance(value, list):
        for item in value:
            values.extend(sensitive_values(item))
    return values


def redact(value, secrets=(), key=""):
    secrets = [str(s) for s in [*secrets, *sensitive_values(value)] if s]

    def clean(item, name=""):
        if _SENSITIVE.search(str(name)):
            return "[已隐藏]"
        if isinstance(item, dict):
            return {k: clean(v, k) for k, v in item.items()}
        if isinstance(item, list):
            return [clean(v) for v in item]
        if isinstance(item, str):
            for secret in secrets:
                item = item.replace(secret, "[已隐藏]")
            return re.sub(r"(?i)((?:token|password|secret|api_key|access_key)=)[^&\s]+", r"\1[已隐藏]", item)
        return item

    return clean(value, key)


def auth_resolver(client, env, login=None, accounts=None, tokens=None):
    cache = dict(tokens or {})
    accounts = {a["role"]: a for a in accounts or []}

    def auth_for(role):
        if cache.get(role):
            return cache[role]
        account = accounts.get(role)
        if not account:
            raise ValueError(f"角色「{role}」没有接口凭据，请保存 token 或账号密码")
        if not login:
            raise ValueError(f"角色「{role}」没有配置接口登录，无法换取 token")
        body = render(login.get("body") or {"username": "${username}", "password": "${password}"}, account, True)
        response = client.request(login.get("method", "POST"), login["path"],
                                  **prepare(env, login, {"json": body, "headers": login.get("headers") or {}, "timeout": login.get("timeout", 120)}))
        decoded = response_body(env, response)
        if response.status_code >= 400:
            raise ValueError(f"角色「{role}」接口登录失败：HTTP {response.status_code}")
        try:
            token = pick(decoded, login.get("token_path") or "data.token")
        except (KeyError, IndexError, ValueError, TypeError) as exc:
            raise ValueError(f"角色「{role}」登录响应找不到 token 字段") from exc
        cache[role] = f"{login.get('prefix', 'Bearer ')}{token}"
        return cache[role]

    return auth_for


def execute(step, client, env, variables, auth_for, label="", trace=None):
    """Execute one request. Trace always records the failure before it propagates."""
    where = f"{label}：" if label else ""
    entry = trace if trace is not None else {}
    entry.update({"name": step.get("name") or f"{step['method']} {step['path']}",
                  "role": step.get("role", ""), "status": "running", "assertions": []})
    start = time.monotonic()
    secrets = [env.get("auth_token", ""), *sensitive_values((env.get("api_crypto") or {}).get("headers", {}))]
    secrets.extend(str(v) for k, v in variables.items() if _SENSITIVE.search(k))
    secrets.extend(sensitive_values(step))
    try:
        resolved = dict(step)
        for key in ("path", "path_params", "query", "headers", "body", "expected_fields", "assertions"):
            if key in step:
                resolved[key] = render(step[key], variables, env.get("strict_vars", False))
        path = resolved["path"]
        for key, value in (resolved.get("path_params") or {}).items():
            from urllib.parse import quote
            path = path.replace("{" + key + "}", quote(str(value), safe=""))
        if re.search(r"\{[^}]+\}", path):
            raise ValueError("路径参数未填写：" + path)
        if not path.startswith("/") or path.startswith("//") or "://" in path:
            raise ValueError("接口路径必须为当前环境的相对路径")
        headers = {k: str(v) for k, v in (resolved.get("headers") or {}).items()}
        if resolved.get("auth", True):
            token = auth_for(resolved.get("role")) if resolved.get("role") else env.get("auth_token", "")
            if token:
                auth_header = env.get("auth_header", "Authorization")
                headers = {k: v for k, v in headers.items() if k.lower() != auth_header.lower()}
                headers[auth_header] = token
                secrets.append(token)
        for key, value in headers.items():
            if _SENSITIVE.search(key) or key.lower() == env.get("auth_header", "authorization").lower():
                secrets.append(value)
        kwargs = {"params": resolved.get("query") or {}, "headers": headers}
        if resolved.get("body") is not None:
            kwargs["json"] = resolved["body"]
        if resolved.get("timeout"):
            kwargs["timeout"] = resolved["timeout"]
        entry["request"] = {"method": resolved["method"], "path": path, **kwargs}
        if step.get("db_setup"):
            try:
                from _aitest_db import configs_from_runtime_env, run_setup
            except ModuleNotFoundError:
                from aitest.db import configs_from_runtime_env, run_setup
            run_setup(configs_from_runtime_env(), step["db_setup"], variables)
        prepared = prepare(env, resolved, kwargs)
        entry["request"] = {"method": resolved["method"], "path": path, **prepared}
        response = client.request(resolved["method"], path, **prepared)
        body = response_body(env, response)
        secrets.extend(sensitive_values(body))
        # Store parsed JSON so sensitive fields can be redacted structurally.
        entry["response"] = {"status_code": response.status_code, "headers": dict(response.headers),
                             "body": body if body is not None else response.text,
                             "size_bytes": len(response.content), "truncated": False}

        def check(name, actual, expected, passed):
            entry["assertions"].append({"name": name, "actual": actual, "expected": expected, "passed": bool(passed)})
            if not passed:
                raise AssertionError(f"{where}状态码 {actual} 不在预期 {expected} 中" if name == "HTTP 状态码" else f"{where}{name}不符合预期")

        if step.get("expected_status"):
            check("HTTP 状态码", response.status_code, step["expected_status"], response.status_code in step["expected_status"])
        if step.get("response_schema"):
            errors = validate(body, step["response_schema"])
            check("响应结构", errors, [], not errors)
        for dotted, expected in (resolved.get("expected_fields") or {}).items():
            try:
                actual = pick(body, dotted)
            except (KeyError, IndexError, TypeError, ValueError):
                actual = "[字段不存在]"
            check(dotted, actual, expected, actual == expected)
        for assertion in resolved.get("assertions") or []:
            dotted, op, expected = assertion["path"], assertion["operator"], assertion.get("value")
            exists = True
            try:
                actual = pick(body, dotted)
            except (KeyError, IndexError, TypeError, ValueError):
                exists, actual = False, None
            if op == "exists":
                passed = exists
            elif op == "not_empty":
                passed = exists and actual is not None and actual != "" and actual != [] and actual != {}
            elif op in ("eq", "ne"):
                passed = exists and ((actual == expected) if op == "eq" else (actual != expected))
            elif op == "contains":
                passed = exists and isinstance(actual, (str, list, dict)) and expected in actual
            else:
                numeric = isinstance(actual, (int, float)) and not isinstance(actual, bool)
                numeric = numeric and isinstance(expected, (int, float)) and not isinstance(expected, bool)
                passed = numeric and {"gt": lambda: actual > expected, "gte": lambda: actual >= expected,
                                      "lt": lambda: actual < expected, "lte": lambda: actual <= expected}[op]()
            check(f"{dotted} {op}", actual if exists else "[字段不存在]", expected, passed)
        for name, dotted in (step.get("extract") or {}).items():
            variables[name] = pick(body, dotted)
        entry["variables"] = {k: variables[k] for k in step.get("extract") or {}}
        if step.get("db_checks"):
            try:
                from _aitest_db import assert_check, configs_from_runtime_env
            except ModuleNotFoundError:
                from aitest.db import assert_check, configs_from_runtime_env
            for spec in step["db_checks"]:
                assert_check(configs_from_runtime_env(), spec, variables)
        entry["status"] = "passed"
        return body
    except Exception as exc:
        entry["status"] = "failed" if isinstance(exc, AssertionError) else "error"
        entry["error"] = redact(str(exc), secrets)
        if isinstance(exc, (ValueError, AssertionError)):
            raise type(exc)(entry["error"]) from None
        raise
    finally:
        entry["duration_ms"] = round((time.monotonic() - start) * 1000)
        # Redact before serializing anywhere, including failures and extraction values.
        cleaned = redact(entry, secrets)
        entry.clear()
        entry.update(cleaned)


def execute_case(case, client, env, shared_vars, auth_for):
    variables = dict(case.get("inputs") or {}) if case.get("variable_scope") == "case" else shared_vars
    config = {**env, "strict_vars": case.get("variable_scope") == "case"}
    steps = case.get("steps") or [case]
    traces, cleanup_traces = [], []
    failed = False
    for index, step in enumerate(steps, 1):
        entry = {"index": index}
        traces.append(entry)
        if failed:
            entry.update({"name": step.get("name") or f"{step['method']} {step['path']}", "status": "blocked"})
            continue
        try:
            label = f"第 {index} 步「{step.get('name') or step['path']}」"
            if step.get("role"):
                label += f"（角色：{step['role']}）"
            execute(step, client, config, variables, auth_for, label, entry)
        except Exception:
            failed = True
    for index, step in enumerate(case.get("cleanup") or [], 1):
        entry = {"index": index}
        cleanup_traces.append(entry)
        try:
            execute(step, client, config, variables, auth_for, f"清理第 {index} 步", entry)
        except Exception:
            failed = True
    status = "error" if any(t["status"] == "error" for t in traces) else "failed" if failed else "passed"
    return {"status": status, "steps": traces, "cleanup": cleanup_traces}
