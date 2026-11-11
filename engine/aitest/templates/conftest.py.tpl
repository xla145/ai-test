# 由 AIProbe 生成，请勿手工修改（重新生成会覆盖）。
#
# 环境与凭据由客户端在执行时通过环境变量注入，脚本与用例数据中不出现明文：
#   AITEST_BASE_URL      被测环境地址
#   AITEST_AUTH_HEADER   鉴权头名称，默认 Authorization
#   AITEST_AUTH_TOKEN    鉴权头的值（由客户端从系统钥匙串读取后注入）
#   AITEST_TIMEOUT       请求超时秒数，默认 30
#   AITEST_ROLE_TOKENS   多账号：角色 → 鉴权头的值（JSON，来自钥匙串）
#   AITEST_ROLES         多账号：角色账号密码（JSON，来自钥匙串），配合 AITEST_API_LOGIN 换取 token
#   AITEST_API_LOGIN     环境的接口登录配置（JSON）：method、path、body（含 ${username} / ${password}）、
#                        token_path（响应中 token 的路径）、prefix（默认 "Bearer "）
#
# 加解密、签名等企业需求：在项目 workspace 下提供 aitest_hooks.py，实现
#   def before_request(request: httpx.Request) -> None
#   def after_response(response: httpx.Response) -> None
# 二者均可选。模型不自行实现这些逻辑。
import importlib
import json
import os
import sys
from pathlib import Path

import httpx
import pytest

_HERE = Path(__file__).parent
for _p in (_HERE, _HERE.parent):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))


def _load_hooks():
    try:
        return importlib.import_module("aitest_hooks")
    except ModuleNotFoundError:
        return None


@pytest.fixture(scope="session")
def aitest_env():
    base_url = os.environ.get("AITEST_BASE_URL")
    if not base_url:
        pytest.exit("未设置 AITEST_BASE_URL，请通过客户端选择执行环境", returncode=4)
    return {
        "base_url": base_url.rstrip("/"),
        "auth_header": os.environ.get("AITEST_AUTH_HEADER", "Authorization"),
        "auth_token": os.environ.get("AITEST_AUTH_TOKEN", ""),
        "timeout": float(os.environ.get("AITEST_TIMEOUT", "30")),
    }


@pytest.fixture(scope="session")
def api_client(aitest_env):
    hooks = _load_hooks()
    event_hooks = {"request": [], "response": []}
    if hooks and hasattr(hooks, "before_request"):
        event_hooks["request"].append(hooks.before_request)
    if hooks and hasattr(hooks, "after_response"):
        event_hooks["response"].append(hooks.after_response)
    with httpx.Client(base_url=aitest_env["base_url"], timeout=aitest_env["timeout"],
                      event_hooks=event_hooks) as client:
        yield client


@pytest.fixture(scope="session")
def role_auth(aitest_env, api_client):
    """多账号：返回函数 角色名 → 鉴权头的值。

    优先用钥匙串中为该角色保存的 token；没有则用该角色的账号密码调用环境的接口登录换取。
    每个角色在一次执行中只登录一次。
    """
    from _aitest_api import pick, render

    tokens = json.loads(os.environ.get("AITEST_ROLE_TOKENS") or "{}")
    accounts = {r["role"]: r for r in json.loads(os.environ.get("AITEST_ROLES") or "[]")}
    login = json.loads(os.environ.get("AITEST_API_LOGIN") or "null")
    cache = {}

    def auth_for(role):
        if role in cache:
            return cache[role]
        if tokens.get(role):
            cache[role] = tokens[role]
            return cache[role]
        account = accounts.get(role)
        if not account:
            pytest.fail(f"角色「{role}」没有接口凭据：请在客户端为该角色保存 token，或保存账号密码并配置接口登录", pytrace=False)
        if not login:
            pytest.fail(f"角色「{role}」只有账号密码，但当前环境没有配置接口登录，无法换取 token", pytrace=False)
        body = render(login.get("body") or {"username": "${username}", "password": "${password}"},
                      {"username": account["username"], "password": account["password"]})
        resp = api_client.request(login.get("method", "POST"), login["path"], json=body,
                                  headers={str(k): str(v) for k, v in (login.get("headers") or {}).items()})
        if resp.status_code >= 400:
            pytest.fail(f"角色「{role}」接口登录失败：状态码 {resp.status_code}，{resp.text[:300]}", pytrace=False)
        try:
            token = pick(resp.json(), login.get("token_path") or "data.token")
        except (KeyError, IndexError, ValueError, TypeError):
            pytest.fail(f"角色「{role}」接口登录的响应中找不到 {login.get('token_path') or 'data.token'}：{resp.text[:300]}",
                        pytrace=False)
        cache[role] = f"{login.get('prefix', 'Bearer ')}{token}"
        return cache[role]

    return auth_for


@pytest.fixture(scope="session")
def shared_vars():
    """接口间依赖：前序用例 extract 的变量，后续用例以 ${var} 引用。"""
    return {}
