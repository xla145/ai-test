"""执行方式路由（第 10 节）。

生成脚本前为每条用例判定 execution_mode。这里是确定性的默认判定（关键词规则），
agent 可在此基础上复核，人工也可修改。
"""

from __future__ import annotations

import re

from .models import ExecutionMode, TestCase

_RULES: list[tuple[str, re.Pattern[str]]] = [
    # 移动端 App：Pinky 探索、Maestro 回归（Android / iOS）
    (ExecutionMode.APP.value, re.compile(r"(App端|APP端|移动端|手机端|iOS|iPhone|iPad|Android|安卓|鸿蒙)", re.I)),
    # 桌面客户端、多浏览器内核：手工
    (ExecutionMode.MANUAL.value, re.compile(r"(桌面客户端|多浏览器|Firefox|Safari|火狐|IE\b|Edge浏览器)", re.I)),
    # 对需求附件做静态核对
    (ExecutionMode.DOC.value, re.compile(r"(埋点表|附件|文档核对|对照.{0,6}文档)")),
    # 埋点抓包
    (ExecutionMode.CAPTURE.value, re.compile(r"(埋点|上报|client_type|pageview|track|抓包)", re.I)),
    # 接口：服务接口、越权与数据隔离、批量请求
    (ExecutionMode.API.value, re.compile(r"(接口|API|越权|数据隔离|批量|请求参数|返回码|状态码|HTTP)", re.I)),
]


def route(case: TestCase) -> str:
    if case.type == "api" or case.is_api_executable:
        return ExecutionMode.API.value
    if case.type == "app":
        return ExecutionMode.APP.value
    # Choose the executor from the operation, not from data labels in expected
    # results (e.g. a web chart displaying Android/iOS consumption).
    text = " ".join([case.title, *case.steps])
    # API Key is a form field/credential name, not evidence of an HTTP test.
    text = re.sub(r"API[\s_-]*Key", "凭据", text, flags=re.I)
    browser_action = re.search(r"(?:点击|输入|选择|勾选|打开|查看).{0,30}(?:按钮|输入框|页面|菜单|弹窗|下拉|列表|表单)|(?:页面|菜单|弹窗|表单).{0,20}(?:点击|输入|选择|查看)", text)
    direct_api = re.search(r"(?:调用|发送|请求).{0,15}(?:接口|HTTP)|(?:GET|POST|PUT|PATCH|DELETE)\s+/", text, re.I)
    for mode, pattern in _RULES:
        if mode == ExecutionMode.API.value and browser_action and not direct_api:
            continue
        if pattern.search(text):
            return mode
    return ExecutionMode.UI.value


def route_all(cases: list[TestCase], overwrite: bool = False) -> dict[str, int]:
    """为用例写入 execution_mode，返回各执行方式的条数。"""
    counts: dict[str, int] = {}
    for c in cases:
        if overwrite or c.execution_mode == ExecutionMode.UI.value:
            c.execution_mode = route(c)
        counts[c.execution_mode] = counts.get(c.execution_mode, 0) + 1
    return counts
