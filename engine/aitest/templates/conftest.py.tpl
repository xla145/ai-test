# 由 AI 测试客户端生成，请勿手工修改（重新生成会覆盖）。
#
# 环境与凭据由客户端在执行时通过环境变量注入，脚本与用例数据中不出现明文：
#   AITEST_BASE_URL      被测环境地址
#   AITEST_AUTH_HEADER   鉴权头名称，默认 Authorization
#   AITEST_AUTH_TOKEN    鉴权头的值（由客户端从系统钥匙串读取后注入）
#   AITEST_TIMEOUT       请求超时秒数，默认 30
#
# 加解密、签名等企业需求：在项目 workspace 下提供 aitest_hooks.py，实现
#   def before_request(request: httpx.Request) -> None
#   def after_response(response: httpx.Response) -> None
# 二者均可选。模型不自行实现这些逻辑。
import importlib
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
def shared_vars():
    """接口间依赖：前序用例 extract 的变量，后续用例以 ${var} 引用。"""
    return {}
