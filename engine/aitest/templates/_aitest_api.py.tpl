# 由 AIProbe 生成，请勿手工修改（重新生成会覆盖）。
# 接口用例的执行：变量替换、按角色鉴权、数据准备、请求、断言、提取与入库校验。单个请求与流程（多步、多账号）共用。
import re

from _aitest_schema import validate

_VAR = re.compile(r"\$\{(\w+)\}")


def render(value, variables):
    """把 ${var} 替换为变量值；整个字符串就是一个变量时保留原类型（数字、对象等）。"""
    if isinstance(value, str):
        whole = _VAR.fullmatch(value)
        if whole and whole.group(1) in variables:
            return variables[whole.group(1)]
        return _VAR.sub(lambda m: str(variables.get(m.group(1), m.group(0))), value)
    if isinstance(value, dict):
        return {k: render(v, variables) for k, v in value.items()}
    if isinstance(value, list):
        return [render(v, variables) for v in value]
    return value


def pick(data, dotted):
    """按点号路径取值，如 data.items.0.id"""
    cur = data
    for part in [p for p in dotted.split(".") if p]:
        if isinstance(cur, list):
            cur = cur[int(part)]
        elif isinstance(cur, dict):
            cur = cur[part]
        else:
            raise KeyError(dotted)
    return cur


def execute(step, client, env, variables, auth_for, label=""):
    """执行一个请求并断言；extract 的变量写回 variables（流程后续步骤与后续用例可用）。

    step["role"] 指定调用者角色时用该角色的凭据，否则用环境的默认 token；step["auth"] 为 False 时不带鉴权。
    """
    where = f"{label}：" if label else ""
    path = render(step["path"], variables)
    for k, v in render(step.get("path_params") or {}, variables).items():
        path = path.replace("{" + k + "}", str(v))
    headers = {k: str(v) for k, v in render(step.get("headers") or {}, variables).items()}
    if step.get("auth", True):
        role = step.get("role") or ""
        token = auth_for(role) if role else env["auth_token"]
        if token:
            headers[env["auth_header"]] = token
    kwargs = {"params": render(step.get("query") or {}, variables), "headers": headers}
    if step.get("body") is not None:
        kwargs["json"] = render(step["body"], variables)

    if step.get("db_setup"):
        from _aitest_db import configs_from_runtime_env, run_setup

        run_setup(configs_from_runtime_env(), step["db_setup"], variables)

    resp = client.request(step["method"], path, **kwargs)

    assert resp.status_code in step["expected_status"], (
        f"{where}{step['method']} {path} 状态码 {resp.status_code} 不在预期 {step['expected_status']} 中；响应：{resp.text[:500]}"
    )
    body = None
    if resp.content and "json" in resp.headers.get("content-type", ""):
        body = resp.json()
    if step.get("response_schema"):
        errors = validate(body, step["response_schema"])
        assert not errors, f"{where}响应结构不符合 schema：" + "; ".join(errors[:10])
    for dotted, expected in (step.get("expected_fields") or {}).items():
        actual = pick(body, dotted)
        want = render(expected, variables)
        assert actual == want, f"{where}字段 {dotted} 实际为 {actual!r}，预期 {want!r}"
    for var, dotted in (step.get("extract") or {}).items():
        variables[var] = pick(body, dotted)
    # 入库校验：查询被测系统数据库（只读），可引用前面提取的变量
    if step.get("db_checks"):
        from _aitest_db import assert_check, configs_from_runtime_env

        configs = configs_from_runtime_env()
        for spec in step["db_checks"]:
            try:
                assert_check(configs, spec, variables)
            except AssertionError as e:
                raise AssertionError(f"{where}{e}") from None
    return body
