# 由 AI 测试客户端生成：数据驱动接口测试，用例数据见 data/{{SUITE}}.json
# 用例 ID：
{{CASE_IDS}}
import json
import re
from pathlib import Path

import pytest

from _aitest_schema import validate

CASES = json.loads((Path(__file__).parent / "data" / "{{SUITE}}.json").read_text(encoding="utf-8"))
_VAR = re.compile(r"\$\{(\w+)\}")


def _render(value, variables):
    if isinstance(value, str):
        whole = _VAR.fullmatch(value)
        if whole and whole.group(1) in variables:
            return variables[whole.group(1)]
        return _VAR.sub(lambda m: str(variables.get(m.group(1), m.group(0))), value)
    if isinstance(value, dict):
        return {k: _render(v, variables) for k, v in value.items()}
    if isinstance(value, list):
        return [_render(v, variables) for v in value]
    return value


def _pick(data, dotted):
    cur = data
    for part in [p for p in dotted.split(".") if p]:
        if isinstance(cur, list):
            cur = cur[int(part)]
        elif isinstance(cur, dict):
            cur = cur[part]
        else:
            raise KeyError(dotted)
    return cur


@pytest.mark.parametrize("case", CASES, ids=[c["case_id"] for c in CASES])
def test_api(case, api_client, aitest_env, shared_vars):
    path = _render(case["path"], shared_vars)
    for k, v in _render(case.get("path_params") or {}, shared_vars).items():
        path = path.replace("{" + k + "}", str(v))
    headers = {k: str(v) for k, v in _render(case.get("headers") or {}, shared_vars).items()}
    if case.get("auth") and aitest_env["auth_token"]:
        headers[aitest_env["auth_header"]] = aitest_env["auth_token"]
    kwargs = {"params": _render(case.get("query") or {}, shared_vars), "headers": headers}
    if case.get("body") is not None:
        kwargs["json"] = _render(case["body"], shared_vars)

    resp = api_client.request(case["method"], path, **kwargs)

    assert resp.status_code in case["expected_status"], (
        f"状态码 {resp.status_code} 不在预期 {case['expected_status']} 中；响应：{resp.text[:500]}"
    )
    body = None
    if resp.content and "json" in resp.headers.get("content-type", ""):
        body = resp.json()
    if case.get("response_schema"):
        errors = validate(body, case["response_schema"])
        assert not errors, "响应结构不符合 schema：" + "; ".join(errors[:10])
    for dotted, expected in (case.get("expected_fields") or {}).items():
        actual = _pick(body, dotted)
        assert actual == _render(expected, shared_vars), f"字段 {dotted} 实际为 {actual!r}，预期 {expected!r}"
    for var, dotted in (case.get("extract") or {}).items():
        shared_vars[var] = _pick(body, dotted)
