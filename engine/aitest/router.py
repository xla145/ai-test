"""执行方式路由（第 10 节）。

生成脚本前为每条用例判定 execution_mode。这里是确定性的默认判定（关键词规则），
agent 可在此基础上复核，人工也可修改。
"""

from __future__ import annotations

import re

from .models import ExecutionMode, TestCase

_RULES: list[tuple[str, re.Pattern[str]]] = [
    # 跨端、多浏览器内核：手工
    (ExecutionMode.MANUAL.value, re.compile(r"(桌面客户端|App端|APP端|移动端|iOS|Android|安卓|多浏览器|Firefox|Safari|火狐|IE\b|Edge浏览器)", re.I)),
    # 对需求附件做静态核对
    (ExecutionMode.DOC.value, re.compile(r"(埋点表|附件|文档核对|对照.{0,6}文档)")),
    # 埋点抓包
    (ExecutionMode.CAPTURE.value, re.compile(r"(埋点|上报|client_type|pageview|track|抓包)", re.I)),
    # 接口：服务接口、越权与数据隔离、批量请求
    (ExecutionMode.API.value, re.compile(r"(接口|API|越权|数据隔离|批量|请求参数|返回码|状态码|HTTP)", re.I)),
]


def route(case: TestCase) -> str:
    if case.type == "api" or case.api is not None:
        return ExecutionMode.API.value
    text = " ".join([case.title, *case.preconditions, *case.steps, *case.expected])
    for mode, pattern in _RULES:
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
